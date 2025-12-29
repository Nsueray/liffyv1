const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
const csv = require('csv-parser');
const db = require('../db');

// --- YARDIMCI FONKSİYONLAR (Metin İçinden Veri Çıkarma) ---

function extractEmails(text) {
  const emails = new Set();
  // Basit ve etkili email regex'i
  const regex = /[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
  const matches = text.match(regex) || [];
  
  matches.forEach(e => {
    const clean = e.toLowerCase().trim();
    // Örnek veya geçersiz mailleri temizle
    const junk = ["example.com", "domain.com", "email.com", ".png", ".jpg", ".jpeg", ".gif"];
    if (!junk.some(j => clean.includes(j))) {
        emails.add(clean);
    }
  });
  return Array.from(emails);
}

function extractPhones(text) {
  const phones = new Set();
  // Uluslararası formatları yakalayan genel regex
  const regex = /(?:\+|00)[1-9]\d{0,3}[\s\.\-]?\(?0?\d{1,4}\)?[\s\.\-]?\d{2,4}[\s\.\-]?\d{2,4}[\s\.\-]?\d{2,4}/g;
  const matches = text.match(regex) || [];
  
  matches.forEach(p => {
    const clean = p.trim();
    // Çok kısa veya aşırı uzun (muhtemelen tarih veya sayı) olanları ele
    if (clean.length > 8 && clean.length < 25) {
        phones.add(clean);
    }
  });
  return Array.from(phones);
}

// --- DOSYA OKUYUCULAR (Parsers) ---

async function parsePdf(filePath) {
  const dataBuffer = fs.readFileSync(filePath);
  const data = await pdf(dataBuffer);
  return data.text;
}

async function parseDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

async function parseExcel(filePath) {
  const workbook = xlsx.readFile(filePath);
  let text = "";
  workbook.SheetNames.forEach(sheetName => {
    const rowObject = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
    // JSON'u stringe çevirip metin havuzuna atıyoruz
    text += JSON.stringify(rowObject) + " ";
  });
  return text;
}

async function parseCsv(filePath) {
  const results = [];
  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => results.push(Object.values(data).join(' '))) // Sadece değerleri al
      .on('end', () => resolve(results.join('\n')))
      .on('error', (err) => reject(err));
  });
}

/**
 * ANA FONKSİYON: Dosyayı İşle
 */
async function runFileMining(job) {
  console.log(`📂 Starting File Miner for Job: ${job.id}`);
  
  // Dosyaların kaydedildiği klasör (uploads/)
  const filePath = path.join(__dirname, '../../uploads', job.input);
  
  // Dosya var mı kontrolü
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found at path: ${filePath}`);
  }

  const ext = path.extname(filePath).toLowerCase();
  let content = "";

  try {
    console.log(`   📄 Parsing ${ext} file...`);
    
    // Uzantıya göre doğru okuyucuyu seç
    if (ext === '.pdf') content = await parsePdf(filePath);
    else if (ext === '.docx') content = await parseDocx(filePath);
    else if (ext === '.xlsx' || ext === '.xls') content = await parseExcel(filePath);
    else if (ext === '.csv') content = await parseCsv(filePath);
    else content = fs.readFileSync(filePath, 'utf8'); // txt vb.

    // Veriyi Çıkar (Extraction)
    const emails = extractEmails(content);
    const phones = extractPhones(content);

    console.log(`   ✅ Extracted: ${emails.length} emails, ${phones.length} phones`);

    // Sonuçları Hazırla
    const results = [];
    
    // Her bir email için bir sonuç satırı oluştur
    if (emails.length > 0) {
        emails.forEach(email => {
            results.push({
                url: job.name, // Kaynak olarak dosya adını kullan
                companyName: "Extracted from File", 
                emails: [email],
                phone: phones.length > 0 ? phones[0] : null, // İlk bulduğu telefonu ekle
                source_type: "file"
            });
        });
    } else if (phones.length > 0) {
        // Email yoksa ama telefon varsa
         phones.forEach(phone => {
            results.push({
                url: job.name,
                companyName: "Extracted from File",
                emails: [],
                phone: phone,
                source_type: "file"
            });
        });
    }

    // Veritabanına Kaydet
    await saveResultsToDb(job, results);

  } catch (err) {
    console.error("File Mining Error:", err);
    throw err;
  }
}

// Sonuçları DB'ye Yazan Fonksiyon
async function saveResultsToDb(job, results) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let totalEmails = 0;

    for (const r of results) {
      totalEmails += r.emails.length;
      
      // Mining Results Tablosuna Ekle
      await client.query(`
        INSERT INTO mining_results 
        (job_id, organizer_id, source_url, company_name, phone, emails, raw)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
          job.id, 
          job.organizer_id, 
          r.url, 
          r.companyName, 
          r.phone, 
          r.emails, 
          JSON.stringify(r)
      ]);
    }

    // İşi Tamamlandı Olarak İşaretle
    const summary = {
        total_found: results.length,
        total_emails: totalEmails,
        file_type: 'file_upload'
    };

    await client.query(`
      UPDATE mining_jobs 
      SET total_found = $1, 
          total_emails_raw = $2, 
          status = 'completed', 
          completed_at = NOW(), 
          stats = $3
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
