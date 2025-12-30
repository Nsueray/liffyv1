const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
const csv = require('csv-parser');
const db = require('../db');
const { Readable } = require('stream');

// --- HELPER FUNCTIONS ---
function extractEmails(text) {
  const emails = new Set();
  const regex = /[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
  const matches = text.match(regex) || [];
  matches.forEach(e => {
    const clean = e.toLowerCase().trim();
    const junk = ["example.com", "domain.com", "email.com", ".png", ".jpg"];
    if (!junk.some(j => clean.includes(j))) emails.add(clean);
  });
  return Array.from(emails);
}

function extractPhones(text) {
  const phones = new Set();
  const regex = /(?:\+|00)[1-9]\d{0,3}[\s\.\-]?\(?0?\d{1,4}\)?[\s\.\-]?\d{2,4}[\s\.\-]?\d{2,4}[\s\.\-]?\d{2,4}/g;
  const matches = text.match(regex) || [];
  matches.forEach(p => {
    if (p.length > 8 && p.length < 25) phones.add(p.trim());
  });
  return Array.from(phones);
}

// --- PARSERS (BUFFER BASED) ---

async function parsePdf(buffer) {
  const data = await pdf(buffer);
  return data.text;
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

  // Dosya verisi DB'den geldi mi?
  if (!job.file_data) {
    throw new Error("No file data found in database for this job.");
  }

  // job.input dosya adını taşıyor
  const filename = job.input.toLowerCase();
  let content = "";

  try {
    console.log(`   📄 Parsing file: ${filename}`);

    if (filename.endsWith('.pdf')) {
        content = await parsePdf(job.file_data);
    } else if (filename.endsWith('.docx') || filename.endsWith('.doc')) {
        content = await parseDocx(job.file_data);
    } else if (filename.endsWith('.xlsx') || filename.endsWith('.xls')) {
        content = await parseExcel(job.file_data);
    } else if (filename.endsWith('.csv')) {
        content = await parseCsv(job.file_data);
    } else {
        // Text tabanlı varsayalım
        content = job.file_data.toString('utf8');
    }

    const emails = extractEmails(content);
    const phones = extractPhones(content);

    console.log(`   ✅ Extracted: ${emails.length} emails, ${phones.length} phones`);

    const results = [];
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
    } else if (phones.length > 0) {
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

    // İş bittiğinde file_data'yı null yaparak DB'yi rahatlatabiliriz (Opsiyonel ama iyi olur)
    await client.query(`
      UPDATE mining_jobs 
      SET total_found = $1, total_emails_raw = $2, status = 'completed', completed_at = NOW(), stats = $3
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
