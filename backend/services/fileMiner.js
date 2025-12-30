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
  // Regex: Basit ve etkili bir email yakalayıcı
  const regex = /[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
  const matches = text.match(regex) || [];
  matches.forEach(e => {
    const clean = e.toLowerCase().trim();
    // Gereksiz "dummy" emailleri filtrele
    const junk = ["example.com", "domain.com", "email.com", ".png", ".jpg", "yourname", "username"];
    if (!junk.some(j => clean.includes(j))) emails.add(clean);
  });
  return Array.from(emails);
}

function extractPhones(text) {
  if (!text) return [];
  const phones = new Set();
  // Regex: Uluslararası ve yerel formatları yakalamaya çalışan genel bir regex
  const regex = /(?:\+|00)[1-9]\d{0,3}[\s\.\-]?\(?0?\d{1,4}\)?[\s\.\-]?\d{2,4}[\s\.\-]?\d{2,4}[\s\.\-]?\d{2,4}/g;
  const matches = text.match(regex) || [];
  matches.forEach(p => {
    if (p.length > 8 && p.length < 25) phones.add(p.trim());
  });
  return Array.from(phones);
}

// --- PARSERS (BUFFER BASED) ---

async function parsePdf(buffer) {
  try {
      const data = await pdf(buffer);
      return data.text;
  } catch (error) {
      console.error("PDF Parsing Error:", error.message);
      // Hata olsa bile pdf-parse bazen kısmi veri döndürür, onu kurtarmayı deneyelim
      return "";
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
  console.log(`📂 Starting File Miner for Job: ${job.id}`);

  // 1. GÜVENLİK KONTROLÜ: Veri var mı?
  if (!job.file_data) {
    throw new Error("No file data found in database for this job.");
  }

  // 2. BUFFER DÖNÜŞÜMÜ (Kritik Düzeltme)
  // Postgres bazen binary veriyi Hex String (\x...) olarak döndürür.
  // Bunu gerçek bir Buffer'a çevirmemiz gerekir.
  let fileBuffer = job.file_data;

  if (!Buffer.isBuffer(fileBuffer)) {
      if (typeof fileBuffer === 'string' && fileBuffer.startsWith('\\x')) {
          // Hex string ise Buffer'a çevir
          console.log("   ⚠️ Converting Postgres Hex String to Buffer...");
          fileBuffer = Buffer.from(fileBuffer.slice(2), 'hex');
      } else if (typeof fileBuffer === 'object') {
           // Bazen JSON objesi gibi gelebilir
           fileBuffer = Buffer.from(fileBuffer);
      } else {
           // String ise
           fileBuffer = Buffer.from(fileBuffer);
      }
  }

  const filename = job.input.toLowerCase();
  let content = "";

  try {
    console.log(`   📄 Parsing file: ${filename} (Size: ${fileBuffer.length} bytes)`);

    if (filename.endsWith('.pdf')) {
        content = await parsePdf(fileBuffer);
    } else if (filename.endsWith('.docx') || filename.endsWith('.doc')) {
        content = await parseDocx(fileBuffer);
    } else if (filename.endsWith('.xlsx') || filename.endsWith('.xls')) {
        content = await parseExcel(fileBuffer);
    } else if (filename.endsWith('.csv')) {
        content = await parseCsv(fileBuffer);
    } else {
        // Text tabanlı varsayalım
        content = fileBuffer.toString('utf8');
    }

    // İçerik boşsa hata fırlatma, log bas (PDF taranmış resim olabilir)
    if (!content || content.trim().length === 0) {
        console.warn("   ⚠️ Warning: Extracted text is empty. File might be an image-only PDF.");
    }

    const emails = extractEmails(content);
    const phones = extractPhones(content);

    console.log(`   ✅ Extracted: ${emails.length} emails, ${phones.length} phones`);

    const results = [];
    
    // Email varsa ekle
    if (emails.length > 0) {
        emails.forEach(email => {
            results.push({
                url: job.input,
                companyName: "File Extraction", 
                emails: [email],
                phone: phones.length > 0 ? phones[0] : null,
                source_type: "file"
            });
        });
    } 
    // Email yok ama telefon varsa ekle
    else if (phones.length > 0) {
         phones.forEach(phone => {
            results.push({
                url: job.input,
                companyName: "File Extraction",
                emails: [],
                phone: phone,
                source_type: "file"
            });
        });
    }

    await saveResultsToDb(job, results);

  } catch (err) {
    console.error("File Mining Error:", err);
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

    // İş bittiğinde file_data'yı sıfırlayarak DB'yi rahatlatıyoruz
    // NOT: Dosyayı saklamak istersen ", file_data = NULL" kısmını silebilirsin.
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
