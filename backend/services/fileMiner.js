const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
const csv = require('csv-parser');
const db = require('../db');
const { Readable } = require('stream');

// --- HELPER FUNCTIONS ---
function extractEmails(text) {
  if (!text) return [];
  const emails = new Set();
  // Regex: Email yakalayıcı
  const regex = /[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
  const matches = text.match(regex) || [];
  matches.forEach(e => {
    const clean = e.toLowerCase().trim();
    // Gereksizleri filtrele
    const junk = ["example.com", "domain.com", "email.com", ".png", ".jpg", "adobe", "srgb"];
    if (!junk.some(j => clean.includes(j))) emails.add(clean);
  });
  return Array.from(emails);
}

function extractPhones(text) {
  if (!text) return [];
  const phones = new Set();
  // Regex: Telefon yakalayıcı
  const regex = /(?:\+|00)[1-9]\d{0,3}[\s\.\-]?\(?0?\d{1,4}\)?[\s\.\-]?\d{2,4}[\s\.\-]?\d{2,4}[\s\.\-]?\d{2,4}/g;
  const matches = text.match(regex) || [];
  matches.forEach(p => {
    if (p.length > 8 && p.length < 25) phones.add(p.trim());
  });
  return Array.from(phones);
}

// --- PARSERS ---

async function parsePdf(buffer) {
  try {
      const data = await pdf(buffer);
      return data.text;
  } catch (error) {
      console.error("❌ PDF Parse Failed (Standard):", error.message);
      return null; // Null dön ki fallback yapabilelim
  }
}

async function parseDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer: buffer });
  return result.value;
}

async function parseExcel(buffer) {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  let text = "";
  workbook.SheetNames.forEach(sheetName => {
    const rowObject = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
    text += JSON.stringify(rowObject) + " ";
  });
  return text;
}

async function parseCsv(buffer) {
  const results = [];
  const stream = Readable.from(buffer);
  return new Promise((resolve, reject) => {
    stream
      .pipe(csv())
      .on('data', (data) => results.push(Object.values(data).join(' ')))
      .on('end', () => resolve(results.join('\n')))
      .on('error', (err) => reject(err));
  });
}

/**
 * MAIN RUNNER
 */
async function runFileMining(job) {
  console.log(`📂 Starting File Miner v3.0 (Smart Buffer) for Job: ${job.id}`);

  if (!job.file_data) {
    throw new Error("No file data found in database.");
  }

  let fileBuffer = job.file_data;

  // 1. BUFFER DÜZELTME MANTIĞI
  // Postgres bazen binary veriyi Hex String olarak döner (\x...)
  // Bazen de bu String'i Buffer içine hapseder. İkisini de çözelim.
  
  // Durum A: String gelirse
  if (!Buffer.isBuffer(fileBuffer)) {
      if (typeof fileBuffer === 'string' && fileBuffer.startsWith('\\x')) {
          fileBuffer = Buffer.from(fileBuffer.slice(2), 'hex');
      } else {
          fileBuffer = Buffer.from(fileBuffer);
      }
  }

  // Durum B: Buffer geldi ama içinde Hex String var (ASCII: \ = 92, x = 120)
  // Bu kontrol hayat kurtarır. Dosya başı '\x' karakterleri mi diye bakar.
  if (fileBuffer.length > 2 && fileBuffer[0] === 0x5c && fileBuffer[1] === 0x78) {
      console.log("   ⚠️ Detected Double-Encoded Buffer (starts with \\x). Fixing...");
      fileBuffer = Buffer.from(fileBuffer.toString('utf8').slice(2), 'hex');
  }

  // Debug: Header kontrolü (%PDF = 25 50 44 46)
  const headerHex = fileBuffer.subarray(0, 8).toString('hex');
  console.log(`   🔍 File Header: ${headerHex} | Size: ${fileBuffer.length} bytes`);

  const filename = job.input.toLowerCase();
  let content = "";
  let usedFallback = false;

  try {
    if (filename.endsWith('.pdf')) {
        content = await parsePdf(fileBuffer);
        // Eğer pdf-parse null dönerse veya boşsa, Fallback'e git
        if (content === null || content.trim().length === 0) {
            console.warn("   ⚠️ PDF text extraction failed or empty. Attempting raw buffer scan...");
            usedFallback = true;
            // Buffer'ı direkt string'e çevirip içinde yazı arayacağız (B Planı)
            content = fileBuffer.toString('latin1'); 
        }
    } else if (filename.endsWith('.docx') || filename.endsWith('.doc')) {
        content = await parseDocx(fileBuffer);
    } else if (filename.endsWith('.xlsx') || filename.endsWith('.xls')) {
        content = await parseExcel(fileBuffer);
    } else if (filename.endsWith('.csv')) {
        content = await parseCsv(fileBuffer);
    } else {
        content = fileBuffer.toString('utf8');
    }

    const emails = extractEmails(content);
    const phones = extractPhones(content);

    console.log(`   ✅ Extracted: ${emails.length} emails, ${phones.length} phones ${usedFallback ? '(via Raw Scan)' : ''}`);

    const results = [];
    // Sonuçları formatla
    if (emails.length > 0) {
        emails.forEach(email => {
            results.push({
                url: job.input, companyName: "File Extraction", 
                emails: [email], phone: phones[0] || null, source_type: "file"
            });
        });
    } else if (phones.length > 0) {
         phones.forEach(phone => {
            results.push({
                url: job.input, companyName: "File Extraction",
                emails: [], phone: phone, source_type: "file"
            });
        });
    }

    await saveResultsToDb(job, results);

  } catch (err) {
    console.error("File Miner Critical Error:", err);
    throw err;
  }
}

async function saveResultsToDb(job, results) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let totalEmails = 0;

    for (const r of results) {
      totalEmails += r.emails.length;
      await client.query(`
        INSERT INTO mining_results 
        (job_id, organizer_id, source_url, company_name, phone, emails, raw)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [job.id, job.organizer_id, r.url, r.companyName, r.phone, r.emails, JSON.stringify(r)]);
    }

    const summary = { total_found: results.length, total_emails: totalEmails, file_type: 'file_upload' };

    // file_data = NULL yaparak DB'yi temizle
    await client.query(`
      UPDATE mining_jobs 
      SET total_found = $1, total_emails_raw = $2, status = 'completed', completed_at = NOW(), stats = $3, file_data = NULL
      WHERE id = $4
    `, [results.length, totalEmails, summary, job.id]);

    await client.query('COMMIT');
    console.log(`💾 Saved ${results.length} results to DB.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { runFileMining };
