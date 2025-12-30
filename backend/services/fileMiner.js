const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
const csv = require('csv-parser');
const db = require('../db');
const { Readable } = require('stream');

// --- 1. AKILLI YARDIMCI FONKSİYONLAR ---

/**
 * Metin içinde en çok geçen ülkeyi bulur.
 */
function detectCountry(text) {
    if (!text) return null;
    const searchSpace = text.slice(0, 5000).toLowerCase(); // Sadece ilk 5000 karaktere bak (Hız için)
    
    // Yaygın ülkeler listesi (Genişletilebilir)
    const countries = [
        { name: "Ghana", keywords: ["ghana", "accra", "kumasi"] },
        { name: "Germany", keywords: ["germany", "deutschland", "berlin"] },
        { name: "USA", keywords: ["usa", "united states", "america", "ny", "california"] },
        { name: "UK", keywords: ["uk", "united kingdom", "london"] },
        { name: "Turkey", keywords: ["turkey", "türkiye", "istanbul", "ankara"] },
        { name: "Nigeria", keywords: ["nigeria", "lagos", "abuja"] },
        { name: "France", keywords: ["france", "paris"] },
        { name: "China", keywords: ["china", "beijing", "shanghai"] }
    ];

    for (const c of countries) {
        if (c.keywords.some(k => searchSpace.includes(k))) {
            return c.name; // İlk eşleşen ülkeyi döndür
        }
    }
    return null; // Bulamazsa boş bırak
}

/**
 * Email adresinden Şirket İsmi ve Web Sitesi türetir.
 * Örn: info@ghana.ahk.de -> Company: "Ghana Ahk", Web: "www.ghana.ahk.de"
 */
function deriveCompanyInfo(email) {
    try {
        const domain = email.split('@')[1];
        if (!domain) return { name: "Unknown Company", web: null };

        // Genel domainleri filtrele
        const genericDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'];
        if (genericDomains.includes(domain)) {
            return { name: "Individual / Freelancer", web: null };
        }

        // Web sitesi
        const website = `www.${domain}`;

        // Şirket ismi türetme (domaini temizle)
        // ghana.ahk.de -> ghana ahk
        let name = domain.split('.')[0]; 
        if (domain.includes('.')) {
            // Uzantıları at (com, org, net, co, gov)
            const parts = domain.split('.');
            // Son parçayı at, geri kalanı birleştir
            if (parts.length > 2) {
                 parts.pop(); // de gitti
                 if(parts[parts.length-1].length <= 3) parts.pop(); // ahk.de -> ahk (veya co.uk -> co gider)
            } else {
                parts.pop(); // com gitti
            }
            name = parts.join(' ');
        }
        
        // Baş harfleri büyüt
        name = name.replace(/\b\w/g, l => l.toUpperCase());

        return { name: name, web: website };
    } catch (e) {
        return { name: "File Extraction", web: null };
    }
}

function extractEmails(text) {
  if (!text) return [];
  const emails = new Set();
  const regex = /[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
  const matches = text.match(regex) || [];
  matches.forEach(e => {
    const clean = e.toLowerCase().trim();
    const junk = ["example.com", "domain.com", "email.com", ".png", ".jpg", "jpeg", "srgb", "adobe", "image"];
    // Email en az 5 karakter olsun ve içinde gereksiz kelimeler olmasın
    if (clean.length > 5 && !junk.some(j => clean.includes(j))) emails.add(clean);
  });
  return Array.from(emails);
}

function extractPhones(text) {
  if (!text) return [];
  const phones = new Set();
  // V3.1: Çok daha katı Regex.
  // En az 10 rakam olmalı. Başında + veya ( olabilir.
  // Tarihleri (2018, 2024) yakalamaması için boşluk/tire zorunluluğu ekleyebiliriz ama format çok değişken.
  const regex = /(?:\+|00)[1-9](?:[\s\-\.]?\d){9,14}/g; 
  
  // Alternatif genel format: (0123) 456 7890
  const regex2 = /\(?0\d{2,4}\)?[\s\-\.]?\d{3,4}[\s\-\.]?\d{3,4}/g;

  const matches = [...(text.match(regex) || []), ...(text.match(regex2) || [])];

  matches.forEach(p => {
    const clean = p.trim();
    // Temizle ve sayıları say
    const digits = clean.replace(/\D/g, '');
    // 20182019 gibi tarihleri elemek zor ama uzunluk kontrolü yapalım
    if (digits.length >= 9 && digits.length <= 15) {
        phones.add(clean);
    }
  });
  return Array.from(phones);
}

// --- 2. PARSERS (AYNI KALDI) ---

async function parsePdf(buffer) {
  try {
      const data = await pdf(buffer);
      return data.text;
  } catch (error) {
      return null; 
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
 * 3. MAIN RUNNER (MANTIK DEĞİŞTİ)
 */
async function runFileMining(job) {
  console.log(`📂 Starting File Miner v4.0 (Smart Extract) for Job: ${job.id}`);

  if (!job.file_data) {
    throw new Error("No file data found in database.");
  }

  let fileBuffer = job.file_data;

  // --- BUFFER FIXES ---
  if (!Buffer.isBuffer(fileBuffer)) {
      if (typeof fileBuffer === 'string' && fileBuffer.startsWith('\\x')) {
          fileBuffer = Buffer.from(fileBuffer.slice(2), 'hex');
      } else {
          fileBuffer = Buffer.from(fileBuffer);
      }
  }
  if (fileBuffer.length > 2 && fileBuffer[0] === 0x5c && fileBuffer[1] === 0x78) {
      fileBuffer = Buffer.from(fileBuffer.toString('utf8').slice(2), 'hex');
  }

  const filename = job.input.toLowerCase();
  let content = "";
  let usedFallback = false;

  // --- PARSING ---
  try {
    if (filename.endsWith('.pdf')) {
        content = await parsePdf(fileBuffer);
        if (content === null || content.trim().length === 0) {
            console.warn("   ⚠️ PDF extraction issue. Switching to Raw Buffer Scan...");
            usedFallback = true;
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

    // --- EXTRACTION ---
    const emails = extractEmails(content);
    const phones = extractPhones(content);
    const detectedCountry = detectCountry(content); // Ülke Tespiti

    console.log(`   ✅ Analysis: ${emails.length} emails, ${phones.length} phones. Country: ${detectedCountry || 'Unknown'}`);

    const results = [];
    
    // --- AKILLI EŞLEŞTİRME (SMART MAPPING) ---
    // Her email için şirket ve web sitesi türet
    // Telefon numarasını "rastgele" atama. Eğer sadece 1 telefon varsa ve 10 email varsa, belki genel şirket telefonudur.
    // Ama güvenli taraf için: Telefonu emaile bağlama, sadece "raw" datada tut veya ayrı kaydet.
    // Şimdilik: Email varsa Company/Web türet, Country ekle.

    // Genel telefon (varsa ilkini al, yoksa null)
    const primaryPhone = phones.length === 1 ? phones[0] : null; 

    if (emails.length > 0) {
        emails.forEach(email => {
            const info = deriveCompanyInfo(email);
            results.push({
                url: info.web || job.input, // Web sitesi varsa onu yaz, yoksa dosya adı kalsın
                companyName: info.name,
                emails: [email],
                phone: primaryPhone, // Sadece 1 telefon varsa kesinlikle şirketindir, dağıt. Yoksa boş geç.
                country: detectedCountry,
                source_type: "file",
                all_phones_found: phones // Bulunan tüm telefonları raw data'da sakla
            });
        });
    } 
    // Email yok ama Telefon var
    else if (phones.length > 0) {
        // İlk 50 telefonu al
        phones.slice(0, 50).forEach(phone => {
            results.push({
                url: job.input, 
                companyName: "Phone Lead",
                emails: [], 
                phone: phone, 
                country: detectedCountry,
                source_type: "file"
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
      // SQL INSERT GÜNCELLENDİ: country sütunu eklendi
      await client.query(`
        INSERT INTO mining_results 
        (job_id, organizer_id, source_url, company_name, phone, emails, country, raw)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
          job.id, 
          job.organizer_id, 
          r.url, 
          r.companyName, 
          r.phone, 
          r.emails, 
          r.country, 
          JSON.stringify(r)
      ]);
    }

    const summary = { total_found: results.length, total_emails: totalEmails, file_type: 'file_upload' };

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
