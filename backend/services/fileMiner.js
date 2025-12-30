const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const db = require('../db');

// Opsiyonel kütüphaneler (Hata almamak için try-catch ile)
let xlsx, mammoth, csvParser;
try { xlsx = require('xlsx'); } catch(e) {}
try { mammoth = require('mammoth'); } catch(e) {}
try { csvParser = require('csv-parser'); } catch(e) {}

// --- AYARLAR ---
const CONFIG = {
    CONTEXT_LINES_ABOVE: 10,
    CONTEXT_LINES_BELOW: 5,
    MIN_CONFIDENCE: 40
};

// --- REGEX DESENLERİ ---
const PATTERNS = {
    email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi,
    
    phone: [
        /\+\d{1,4}[\s\-\.]?\(?\d{1,4}\)?[\s\-\.]?\d{2,4}[\s\-\.]?\d{2,4}/g,
        /00\d{1,4}[\s\-\.]?\d{2,4}[\s\-\.]?\d{2,4}[\s\-\.]?\d{2,4}/g,
        /\+233\s?\(0\)\s?\d{2,3}[\s\-]?\d{3}[\s\-]?\d{3,4}/g,
        /(?:\b0)(?:[235][0-9])[\s\-]?\d{3}[\s\-]?\d{4}\b/g,
        /\b\d{3}[\-]\d{3}[\-]\d{4}\b/g
    ],

    website: [
        /https?:\/\/[^\s<>"']+/gi,
        /www\.[a-zA-Z0-9][a-zA-Z0-9\-]*\.[a-zA-Z]{2,}[^\s<>"']*/gi
    ],

    companyIndicators: /(?:Ltd|Limited|Inc|Corp|Corporation|LLC|GmbH|AG|Company|Co\.|Authority|Agency|Commission|Ministry|Department|Institute|Association|Group|Ventures|Consult|Solutions|Services|Enterprises|Holdings|Bank)/i,

    labels: {
        address: /^(?:Address|Postal Address|Location|Office|Hq)\s*[:\.]?\s*(.+)/i,
        phone: /^(?:Telephone|Tel|Phone|Mobile|Cell|Fax)\s*[:\.]?\s*(.+)/i,
        website: /^(?:Website|Web|URL)\s*[:\.]?\s*(.+)/i
    }
};

// ============================================
// 1. DOSYA OKUYUCULAR
// ============================================

// PDF Okuyucu (FIXED)
async function extractFromPDF(buffer) {
    const tempPath = path.join(os.tmpdir(), `liffy_${Date.now()}_${Math.random().toString(36).substr(7)}.pdf`);
    try {
        await fs.promises.writeFile(tempPath, buffer);
        // Eğer sistemde pdftotext yoksa burada hata fırlatır ve catch bloğuna düşer
        const { stdout } = await execPromise(`pdftotext -layout -enc UTF-8 "${tempPath}" -`);
        return stdout;
    } catch (e) {
        console.warn("⚠️ pdftotext failed (using raw fallback):", e.message);
        return buffer.toString('utf8'); // Fallback olarak raw text dene
    } finally {
        // HATA DÜZELTİLDİ: fs.promises.unlink kullanıldı
        try { await fs.promises.unlink(tempPath); } catch (e) {}
    }
}

async function extractFromExcel(buffer) {
    if (!xlsx) return "";
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    let sheetsData = [];
    for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        sheetsData.push(data);
    }
    return { type: 'structured', data: sheetsData };
}

async function extractFromWord(buffer) {
    if (!mammoth) return "";
    const result = await mammoth.extractRawText({ buffer: buffer });
    return result.value;
}

// ============================================
// 2. MADENCİLİK MOTORU
// ============================================

function mineUnstructuredData(text) {
    const lines = text.split(/\r?\n/);
    const contacts = [];
    const processedEmails = new Set();

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const emailMatches = line.match(PATTERNS.email) || [];
        
        for (const email of emailMatches) {
            const emailLower = email.toLowerCase();
            if (processedEmails.has(emailLower)) continue;
            if (['.png', '.jpg', 'example.com', 'email.com'].some(ext => emailLower.includes(ext))) continue;

            processedEmails.add(emailLower);

            const start = Math.max(0, i - CONFIG.CONTEXT_LINES_ABOVE);
            const end = Math.min(lines.length, i + CONFIG.CONTEXT_LINES_BELOW);
            const contextLines = lines.slice(start, end);
            const contextText = contextLines.join('\n');

            let company = findCompanyNameInContext(lines, i, emailLower);
            const phones = extractPhones(contextText);
            const websites = extractWebsites(contextText);
            const addresses = extractAddresses(contextLines, i - start);
            const country = detectCountry(contextText);

            let website = websites[0];
            if (!website) website = deriveWebsiteFromEmail(emailLower);

            const confidence = calculateConfidence({ email, company, phones, website, addresses });

            if (confidence >= CONFIG.MIN_CONFIDENCE) {
                contacts.push({
                    email: emailLower,
                    companyName: company || deriveCompanyFromEmail(emailLower),
                    phone: phones[0] || null,
                    website: website,
                    country: country,
                    addresses: addresses,
                    all_phones: phones,
                    confidence: confidence,
                    source_type: 'file_unstructured'
                });
            }
        }
    }
    return contacts;
}

function mineStructuredData(sheetsData) {
    const contacts = [];
    sheetsData.forEach(rows => {
        if (!Array.isArray(rows)) return;
        rows.forEach(row => {
            if (!Array.isArray(row)) return;
            let email = null;
            let company = null;
            let rowText = row.join(' ');

            row.forEach(cell => {
                const cellStr = String(cell);
                if (PATTERNS.email.test(cellStr)) {
                    email = cellStr.match(PATTERNS.email)[0];
                }
            });

            if (email) {
                const phones = extractPhones(rowText);
                const websites = extractWebsites(rowText);
                row.forEach(cell => {
                    const cellStr = String(cell);
                    if (cellStr.length > 3 && PATTERNS.companyIndicators.test(cellStr) && !PATTERNS.email.test(cellStr)) {
                        company = cellStr;
                    }
                });

                contacts.push({
                    email: email.toLowerCase(),
                    companyName: company || deriveCompanyFromEmail(email),
                    phone: phones[0] || null,
                    website: websites[0] || deriveWebsiteFromEmail(email),
                    country: detectCountry(rowText),
                    all_phones: phones,
                    confidence: 90,
                    source_type: 'file_structured'
                });
            }
        });
    });
    return contacts;
}

// ============================================
// 3. YARDIMCI FONKSİYONLAR
// ============================================

function findCompanyNameInContext(lines, emailIndex, email) {
    for (let i = 1; i <= CONFIG.CONTEXT_LINES_ABOVE; i++) {
        const lineIndex = emailIndex - i;
        if (lineIndex < 0) break;
        const line = lines[lineIndex].trim();
        if (line.length < 3) continue;
        if (/^(Address|Tel|Phone|Email|Web|Fax|Location)/i.test(line)) continue;

        if (PATTERNS.companyIndicators.test(line) && line.length < 80) {
            return line.replace(/^(Name|Company|Organization)\s*[:\.]?\s*/i, '').trim();
        }
        if (/^[A-Z]/.test(line) && line.length > 4 && line.length < 60 && !line.includes('.')) {
            if (lines[lineIndex + 1] && /Address/i.test(lines[lineIndex + 1])) {
                return line;
            }
        }
    }
    return null;
}

function extractPhones(text) {
    const phones = new Set();
    PATTERNS.phone.forEach(regex => {
        const matches = text.match(regex) || [];
        matches.forEach(p => {
            const clean = p.replace(/[^\d+]/g, '');
            if (clean.length >= 7 && clean.length <= 15) {
                if (!/^20\d{2}$/.test(clean)) phones.add(p.trim());
            }
        });
    });
    return Array.from(phones);
}

function extractWebsites(text) {
    const sites = new Set();
    PATTERNS.website.forEach(regex => {
        const matches = text.match(regex) || [];
        matches.forEach(w => {
            let url = w.trim().replace(/[.,;:]$/, '');
            if (!url.startsWith('http')) url = 'https://' + url;
            if (!url.includes('@')) sites.add(url);
        });
    });
    return Array.from(sites);
}

function extractAddresses(contextLines, relativeEmailIdx) {
    const addresses = [];
    contextLines.forEach(line => {
        if (/^(Address|Location|P\.?O\.?\s?Box)/i.test(line)) {
            addresses.push(line.replace(/^(Address|Location)\s*[:\.]?\s*/i, '').trim());
        }
    });
    return addresses;
}

function deriveCompanyFromEmail(email) {
    try {
        const domain = email.split('@')[1];
        if (['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'].includes(domain)) return "Individual";
        let name = domain.split('.')[0];
        return name.charAt(0).toUpperCase() + name.slice(1);
    } catch (e) { return "Unknown"; }
}

function deriveWebsiteFromEmail(email) {
    const domain = email.split('@')[1];
    if (['gmail.com', 'yahoo.com'].includes(domain)) return null;
    return 'www.' + domain;
}

function detectCountry(text) {
    const search = text.slice(0, 5000).toLowerCase();
    const countries = ["Ghana", "Germany", "USA", "United States", "UK", "United Kingdom", "Turkey", "France", "Nigeria", "China"];
    for (const c of countries) {
        if (search.includes(c.toLowerCase())) return c;
    }
    return null;
}

function calculateConfidence(data) {
    let score = 0;
    if (data.email) score += 40;
    if (data.phones.length > 0) score += 20;
    if (data.website) score += 10;
    if (data.company && data.company !== "Individual") score += 20;
    if (data.addresses && data.addresses.length > 0) score += 10;
    return Math.min(100, score);
}

// ============================================
// 4. MAIN RUNNER
// ============================================
async function runFileMining(job) {
    console.log(`📂 Starting Universal File Miner v7.1 for Job: ${job.id}`);
    if (!job.file_data) throw new Error("No file data found.");

    let fileBuffer = job.file_data;
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
    let contacts = [];

    try {
        if (filename.endsWith('.pdf')) {
            const text = await extractFromPDF(fileBuffer);
            contacts = mineUnstructuredData(text);
        } else if (filename.endsWith('.xlsx') || filename.endsWith('.xls')) {
            const result = await extractFromExcel(fileBuffer);
            if (result.type === 'structured') contacts = mineStructuredData(result.data);
        } else if (filename.endsWith('.docx') || filename.endsWith('.doc')) {
            const text = await extractFromWord(fileBuffer);
            contacts = mineUnstructuredData(text);
        } else {
            const text = fileBuffer.toString('utf8');
            if ((text.match(/,/g) || []).length > (text.split('\n').length)) {
                const rows = text.split('\n').map(r => r.split(/,|;/));
                contacts = mineStructuredData([rows]);
            } else {
                contacts = mineUnstructuredData(text);
            }
        }

        console.log(`   ✅ Mining Complete. Found ${contacts.length} contacts.`);
        await saveResultsToDb(job, contacts);
    } catch (err) {
        console.error("Critical Miner Error:", err);
        throw err;
    }
}

async function saveResultsToDb(job, results) {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        let totalEmails = 0;
        for (const r of results) {
            totalEmails++;
            await client.query(`
                INSERT INTO mining_results 
                (job_id, organizer_id, source_url, company_name, phone, emails, country, raw)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [job.id, job.organizer_id, r.website || job.input, r.companyName, r.phone, [r.email], r.country, JSON.stringify(r)]);
        }
        const summary = { total_found: results.length, total_emails: totalEmails, file_type: 'universal' };
        await client.query(`
            UPDATE mining_jobs 
            SET total_found = $1, total_emails_raw = $2, status = 'completed', completed_at = NOW(), stats = $3, file_data = NULL
            WHERE id = $4
        `, [results.length, totalEmails, summary, job.id]);
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

module.exports = { runFileMining };
