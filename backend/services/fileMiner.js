const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
const csv = require('csv-parser');
const db = require('../db');
const { Readable } = require('stream');

// --- 1. AKILLI BLOK ANALİZİ (SMART BLOCK PARSER) ---

/**
 * Bu fonksiyon metni satırlara böler ve her bir iletişim bilgisini (email)
 * ait olduğu "paragraf bloğu" içinde analiz eder.
 */
function extractEntitiesFromText(text) {
    if (!text) return [];

    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    const results = [];
    const usedEmails = new Set();

    // Regex Tanımları
    const emailRegex = /[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i;
    // Telefon: + ile başlayan, 00 ile başlayan veya parantezli formatlar
    const phoneRegex = /(?:\+|00)[1-9]\d{1,3}[\s\-\.]?(?:\(?\d{1,4}\)?[\s\-\.]?)?\d{3,4}[\s\-]?\d{3,4}/g;
    const urlRegex = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;

    // Her satırı gez
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Bu satırda email var mı?
        const emailMatch = line.match(emailRegex);
        
        if (emailMatch) {
            const email = emailMatch[0].toLowerCase();
            
            // Gereksiz emailleri ele
            const junk = ["example.com", "domain.com", "email.com", ".png", ".jpg", "jpeg"];
            if (usedEmails.has(email) || junk.some(j => email.includes(j))) continue;
            
            usedEmails.add(email);

            // --- BAĞLAM ANALİZİ (CONTEXT ANALYSIS) ---
            // Email bulduk. Şimdi bu emailin ait olduğu "bloğu" (çevresindeki 10 satır) inceleyelim.
            // Yukarı doğru 5-6 satır, aşağı doğru 2-3 satır.
            
            let companyName = null;
            let website = null;
            let phone = null;
            let country = null;

            // 1. Şirket İsmini Bul (Yukarı doğru tarama)
            // Genelde şirket ismi, iletişim bilgilerinin 1-5 satır üstündedir.
            // Kriter: "Kısa", "Baş harfleri büyük" veya "Tamamı büyük" satırlar daha olasıdır.
            for (let j = 1; j <= 6; j++) {
                if (i - j < 0) break;
                const prevLine = lines[i - j];
                
                // Eğer satır "Address:", "Tel:", "Email:" gibi teknik bir satırsa atla
                if (/^(address|tel|phone|email|website|fax|location)/i.test(prevLine)) continue;

                // Eğer satır çok uzunsa (açıklama metniyse) muhtemelen şirket ismi değildir, ama içinde geçebilir.
                if (prevLine.length > 100) continue;

                // Eğer parantez içinde kısaltma varsa (örn: "(CWSA)"), bunu şirket ismi olarak alabiliriz ama
                // asıl hedefimiz ondan bir önceki satırdaki "Community Water..." olmalı.
                
                // Basit mantık: İlk anlamlı, teknik olmayan satırı aday olarak al.
                // Eğer satırda "Agency", "Authority", "Commission", "Ltd", "Inc", "Company" geçiyorsa o kesin şirkettir.
                if (/(Agency|Authority|Commission|Limited|Ltd|Inc|Company|Group|Corporation|Council|Department|Ministry)/i.test(prevLine)) {
                    companyName = prevLine;
                    break; 
                }
                
                // Eğer henüz bulamadıysak ve satır "Title Case" (Baş Harfler Büyük) ise aday yap
                // Örn: "The Ghana Standards Authority"
                if (!companyName && /^[A-Z]/.test(prevLine) && prevLine.length > 3) {
                    companyName = prevLine;
                }
            }

            // 2. Web Sitesini Bul (Yakın çevrede tarama: i-2 ile i+3 arası)
            for (let k = -2; k <= 3; k++) {
                if (i + k < 0 || i + k >= lines.length) continue;
                const nearLine = lines[i + k];
                
                // "Website:" veya "www." arıyoruz
                if (nearLine.toLowerCase().includes('www.') || nearLine.toLowerCase().includes('http')) {
                    const urlMatch = nearLine.match(urlRegex);
                    if (urlMatch) {
                        website = urlMatch[0]; // www.gsa.gov.gh
                        // Eğer web sitesi http içermiyorsa ekle
                        if (!website.startsWith('http')) website = 'http://' + website;
                        break;
                    }
                }
            }
            // Eğer web sitesi bulunamadıysa emailden türet
            if (!website) {
                const domain = email.split('@')[1];
                if (!['gmail.com', 'yahoo.com', 'hotmail.com'].includes(domain)) {
                    website = 'www.' + domain;
                }
            }

            // 3. Telefonu Bul (Yakın çevrede tarama)
            for (let k = -3; k <= 3; k++) {
                if (i + k < 0 || i + k >= lines.length) continue;
                const nearLine = lines[i + k];
                const phonesInLine = nearLine.match(phoneRegex);
                if (phonesInLine) {
                    // İlk geçerli telefonu al
                    phone = phonesInLine[0];
                    break;
                }
            }

            // 4. Ülkeyi Bul (Yakın çevrede tarama)
            const countryKeywords = ["Ghana", "Germany", "USA", "UK", "Turkey", "Nigeria", "France", "China"];
            for (let k = -5; k <= 5; k++) {
                 if (i + k < 0 || i + k >= lines.length) continue;
                 const nearLine = lines[i + k];
                 for (const c of countryKeywords) {
                     if (nearLine.includes(c)) {
                         country = c;
                         break;
                     }
                 }
                 if (country) break;
            }

            // Fallback: Şirket ismi hala yoksa, email domaininden türet (Eski yöntem)
            if (!companyName) {
                const domainParts = email.split('@')[1].split('.');
                companyName = domainParts[0].charAt(0).toUpperCase() + domainParts[0].slice(1);
            }

            // Temizlik
            if (companyName) {
                // Parantez içindeki kısaltmaları temizle veya koru. 
                // Örn: "The Ghana Standards Authority (GSA)" -> Olduğu gibi kalabilir.
                companyName = companyName.replace(/Address:|Tel:|Email:|Website:/gi, '').trim();
            }

            results.push({
                email: email,
                companyName: companyName,
                website: website,
                phone: phone,
                country: country
            });
        }
    }
    return results;
}

// --- 2. PARSERS (Buffer Fix Dahil) ---

async function parsePdf(buffer) {
  try {
      const data = await pdf(buffer);
      // PDF-Parse satır sonlarını bazen yutar, onları korumaya çalışalım.
      // Ancak pdf-parse genelde \n verir.
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
    // Excel'i satır satır metne çevir ki blok analizi çalışsın
    const sheet = workbook.Sheets[sheetName];
    const json = xlsx.utils.sheet_to_json(sheet, { header: 1 }); // Array of arrays
    text += json.map(row => row.join(" ")).join("\n") + "\n";
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
 * 3. MAIN RUNNER
 */
async function runFileMining(job) {
  console.log(`📂 Starting File Miner v5.0 (Block Context) for Job: ${job.id}`);

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

  console.log(`   📄 Parsing: ${filename} | Size: ${fileBuffer.length}`);

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

    // --- ENTITY EXTRACTION WITH CONTEXT ---
    // Artık tüm metni tek bir Regex ile taramak yerine, satır satır analiz ediyoruz.
    const extractedData = extractEntitiesFromText(content);

    console.log(`   ✅ Analysis: Found ${extractedData.length} structured contacts.`);

    const results = [];
    
    // Verileri işle
    extractedData.forEach(data => {
        results.push({
            url: data.website || job.input, // Websitesi bulunduysa onu kullan
            companyName: data.companyName || "Unknown Company",
            emails: [data.email],
            phone: data.phone,
            country: data.country,
            source_type: "file",
            raw_context: { detected_from_block: true } // Debug için
        });
    });

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
