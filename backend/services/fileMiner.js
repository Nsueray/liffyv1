const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const db = require('../db');

// --- KÜTÜPHANELER ---
let xlsx, mammoth, pdfParse;
try { xlsx = require('xlsx'); } catch(e) {}
try { mammoth = require('mammoth'); } catch(e) {}
try { pdfParse = require('pdf-parse'); } catch(e) {}

// --- AYARLAR ---
const CONFIG = {
    CONTEXT_LINES_ABOVE: 15,
    CONTEXT_LINES_BELOW: 10,
    MIN_CONFIDENCE: 40,
    PDF_TIMEOUT: 60000,
    MAX_BUFFER: 50 * 1024 * 1024,
    MIN_TEXT_LENGTH: 500 // Bu uzunluktan az metin çıkarsa fallback'e geç
};

// --- DOMAIN MAPPING ---
const DOMAIN_MAP = {
    'gwcl': 'Ghana Water Company Limited',
    'cwsa': 'Community Water and Sanitation Agency',
    'purcghana': 'Public Utilities Regulatory Commission',
    'mlgrd': 'Ministry of Local Government & Rural Development',
    'gsa.gov.gh': 'Ghana Standards Authority',
    'epa.gov.gh': 'Environmental Protection Agency',
    'wrc-gh': 'Water Resources Commission',
    'csir-water': 'Water Research Institute (CSIR)',
    'volticghana': 'Voltic Ghana Limited',
    'blowgroup': 'Bel-Aqua (Blow-Chem Industries)',
    'jekoraventures': 'Jekora Ventures Ltd',
    'jospongroup': 'Jospong Group of Companies',
    'wateraid': 'WaterAid',
    'safewaternetwork': 'Safe Water Network',
    'unicef': 'UNICEF',
    'worldbank': 'The World Bank',
    'undp': 'UNDP'
};

// --- REGEX DESENLERİ ---
const PATTERNS = {
    email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi,
    phone: [
        /\+\d{1,4}[\s\-\.]?\(?\d{1,4}\)?[\s\-\.]?\d{2,4}[\s\-\.]?\d{2,4}/g,
        /00\d{1,4}[\s\-\.]?\d{2,4}[\s\-\.]?\d{2,4}[\s\-\.]?\d{2,4}/g,
        /\+233\s?\(0\)\s?\d{2,3}[\s\-]?\d{3}[\s\-]?\d{3,4}/g,
        /0[23][0-9]{1,2}[\s\-]?\d{3}[\s\-]?\d{3,4}/g,
        /0[245][0-9][\s\-]?\d{3}[\s\-]?\d{4}/g,
        /\(\d{2,4}\)[\s\-]?\d{3,4}[\s\-]?\d{3,4}/g,
        /\d{3}[\-]\d{3}[\-]\d{4,6}/g,
        /\d{3}\s\d{3}\s\d{4}/g
    ],
    website: [
        /https?:\/\/[^\s<>"']+/gi,
        /www\.[a-zA-Z0-9][a-zA-Z0-9\-]*\.[a-zA-Z]{2,}[^\s<>"']*/gi
    ],
    companyIndicators: /(?:Ltd|Limited|Inc|Corp|Corporation|LLC|GmbH|AG|Company|Co\.|Authority|Agency|Commission|Ministry|Department|Institute|Association|Group|Ventures|Consult|Solutions|Services|Enterprises|Holdings|Bank|Council|Directorate)/i
};

// ============================================
// 1. BUFFER DÜZELTME
// ============================================
function ensureBuffer(input) {
    if (Buffer.isBuffer(input)) return input;
    
    if (typeof input === 'string') {
        if (input.startsWith('\\x')) {
            console.log("   🛠️ Converting Postgres Bytea...");
            return Buffer.from(input.slice(2), 'hex');
        }
        if (input.match(/^[A-Za-z0-9+/=]+$/) && input.length > 100) {
            return Buffer.from(input, 'base64');
        }
        return Buffer.from(input);
    }
    
    if (input && input.type === 'Buffer' && Array.isArray(input.data)) {
        return Buffer.from(input.data);
    }

    throw new Error(`Unknown data type: ${typeof input}`);
}

// ============================================
// 2. PDF EXTRACTION - UNIVERSAL FALLBACK CHAIN
// ============================================

async function extractFromPDF(buffer) {
    const tempPath = path.join(os.tmpdir(), `liffy_${Date.now()}.pdf`);
    
    try {
        await fs.promises.writeFile(tempPath, buffer);
        console.log("   📄 Starting Universal PDF Extraction Chain...");
        
        let text = '';
        let method = '';

        // ========== METHOD 1: pdftotext (Poppler) ==========
        try {
            console.log("   [1/4] Trying pdftotext...");
            const { stdout } = await execPromise(
                `pdftotext -layout -enc UTF-8 "${tempPath}" - 2>/dev/null`,
                { timeout: CONFIG.PDF_TIMEOUT, maxBuffer: CONFIG.MAX_BUFFER }
            );
            
            // Gerçek metin var mı kontrol et (sadece whitespace/control char değil)
            const realText = stdout.replace(/[\s\f\r\n]/g, '');
            if (realText.length >= CONFIG.MIN_TEXT_LENGTH) {
                text = stdout;
                method = 'pdftotext';
                console.log(`   ✅ pdftotext SUCCESS: ${realText.length} chars`);
            } else {
                console.log(`   ⚠️ pdftotext: Only ${realText.length} chars (insufficient)`);
            }
        } catch (e) {
            console.log(`   ⚠️ pdftotext failed: ${e.message}`);
        }

        // ========== METHOD 2: mutool (MuPDF) ==========
        if (!text) {
            try {
                console.log("   [2/4] Trying mutool (MuPDF)...");
                const { stdout } = await execPromise(
                    `mutool draw -F txt -o - "${tempPath}" 2>/dev/null`,
                    { timeout: CONFIG.PDF_TIMEOUT, maxBuffer: CONFIG.MAX_BUFFER }
                );
                
                const realText = stdout.replace(/[\s\f\r\n]/g, '');
                if (realText.length >= CONFIG.MIN_TEXT_LENGTH) {
                    text = stdout;
                    method = 'mutool';
                    console.log(`   ✅ mutool SUCCESS: ${realText.length} chars`);
                } else {
                    console.log(`   ⚠️ mutool: Only ${realText.length} chars (insufficient)`);
                }
            } catch (e) {
                console.log(`   ⚠️ mutool failed: ${e.message}`);
            }
        }

        // ========== METHOD 3: pdf-parse (JavaScript - Pure) ==========
        if (!text && pdfParse) {
            try {
                console.log("   [3/4] Trying pdf-parse (JS)...");
                const data = await pdfParse(buffer);
                
                const realText = data.text.replace(/[\s\f\r\n]/g, '');
                if (realText.length >= CONFIG.MIN_TEXT_LENGTH) {
                    text = data.text;
                    method = 'pdf-parse';
                    console.log(`   ✅ pdf-parse SUCCESS: ${realText.length} chars`);
                } else {
                    console.log(`   ⚠️ pdf-parse: Only ${realText.length} chars (insufficient)`);
                }
            } catch (e) {
                console.log(`   ⚠️ pdf-parse failed: ${e.message}`);
            }
        }

        // ========== METHOD 4: Raw Buffer Scan (Last Resort) ==========
        if (!text) {
            try {
                console.log("   [4/4] Trying raw buffer scan...");
                const rawText = buffer.toString('latin1');
                
                // PDF içinden metin parçalarını çıkarmaya çalış
                const textMatches = rawText.match(/\(([^)]+)\)/g) || [];
                const extracted = textMatches
                    .map(m => m.slice(1, -1))
                    .filter(t => t.length > 3 && /[a-zA-Z]/.test(t))
                    .join(' ');
                
                if (extracted.length >= 100) {
                    text = extracted;
                    method = 'raw-scan';
                    console.log(`   ✅ raw-scan SUCCESS: ${extracted.length} chars`);
                } else {
                    console.log(`   ⚠️ raw-scan: Only ${extracted.length} chars`);
                }
            } catch (e) {
                console.log(`   ⚠️ raw-scan failed: ${e.message}`);
            }
        }

        // ========== SONUÇ ==========
        if (text) {
            console.log(`   🎉 PDF Extraction Complete via [${method}]: ${text.length} total chars`);
            return text;
        } else {
            console.error("   ❌ ALL PDF METHODS FAILED - No text extracted");
            return '';
        }

    } finally {
        try { await fs.promises.unlink(tempPath); } catch (e) {}
    }
}

// ============================================
// 3. EXCEL & WORD READERS
// ============================================

async function extractFromExcel(buffer) {
    if (!xlsx) return "";
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    let sheetsData = [];
    for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        sheetsData.push(xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' }));
    }
    return { type: 'structured', data: sheetsData };
}

async function extractFromWord(buffer) {
    if (!mammoth) return "";
    const result = await mammoth.extractRawText({ buffer: buffer });
    return result.value;
}

// ============================================
// 4. MINING ENGINE
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
            if (['.png', '.jpg', 'example.com', 'email.com', 'domain.com'].some(ext => emailLower.includes(ext))) continue;

            processedEmails.add(emailLower);

            const start = Math.max(0, i - CONFIG.CONTEXT_LINES_ABOVE);
            const end = Math.min(lines.length, i + CONFIG.CONTEXT_LINES_BELOW);
            const contextLines = lines.slice(start, end);
            const contextText = contextLines.join('\n');

            let company = findCompanyNameInContext(lines, i, emailLower);
            const phones = extractPhones(contextText);
            const websites = extractWebsites(contextText);
            const addresses = extractAddresses(contextLines);
            const country = detectCountry(contextText);

            let website = websites[0] || deriveWebsiteFromEmail(emailLower);
            if (!company || company === "Unknown") {
                company = deriveCompanyFromEmail(emailLower);
            }

            const confidence = calculateConfidence({ email, company, phones, website, addresses });

            if (confidence >= CONFIG.MIN_CONFIDENCE) {
                contacts.push({
                    email: emailLower,
                    companyName: company,
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
            let email = null, company = null, rowText = row.join(' ');
            
            row.forEach(cell => {
                if (PATTERNS.email.test(String(cell))) email = String(cell).match(PATTERNS.email)[0];
            });

            if (email) {
                const phones = extractPhones(rowText);
                const websites = extractWebsites(rowText);
                row.forEach(cell => {
                    const str = String(cell);
                    if (str.length > 3 && PATTERNS.companyIndicators.test(str) && !PATTERNS.email.test(str)) company = str;
                });
                
                if (!company) company = deriveCompanyFromEmail(email.toLowerCase());

                contacts.push({
                    email: email.toLowerCase(),
                    companyName: company,
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
// 5. HELPER FUNCTIONS
// ============================================

function findCompanyNameInContext(lines, emailIndex, email) {
    const domain = email.split('@')[1];
    for (const [key, val] of Object.entries(DOMAIN_MAP)) {
        if (domain.includes(key)) return val;
    }

    for (let i = 1; i <= CONFIG.CONTEXT_LINES_ABOVE; i++) {
        const lineIndex = emailIndex - i;
        if (lineIndex < 0) break;
        const line = lines[lineIndex].trim();
        if (line.length < 3 || /^(Address|Tel|Phone|Email|Web)/i.test(line)) continue;

        if (PATTERNS.companyIndicators.test(line) && line.length < 80) {
            return line.replace(/^(Name|Company|Organization)\s*[:\.]?\s*/i, '').trim();
        }
        if (/^[A-Z]/.test(line) && line.length > 4 && line.length < 60 && !line.endsWith('.')) {
            if (lines[lineIndex + 1] && /Address|Box/i.test(lines[lineIndex + 1])) return line;
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
            if (clean.length >= 7 && clean.length <= 15 && !/^20\d{2}$/.test(clean)) phones.add(p.trim());
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

function extractAddresses(contextLines) {
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
        for (const [key, val] of Object.entries(DOMAIN_MAP)) {
            if (domain.includes(key)) return val;
        }
        if (['gmail.com', 'yahoo.com', 'hotmail.com'].includes(domain)) return "Individual";
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
    const search = text.slice(0, 10000).toLowerCase();
    const countries = ["Ghana", "Germany", "USA", "United Kingdom", "Turkey", "France", "Nigeria", "China"];
    for (const c of countries) { if (search.includes(c.toLowerCase())) return c; }
    return null;
}

function calculateConfidence(data) {
    let score = 0;
    if (data.email) score += 40;
    if (data.phones.length > 0) score += 20;
    if (data.website) score += 10;
    if (data.company && data.company !== "Unknown") score += 20;
    if (data.addresses && data.addresses.length > 0) score += 10;
    return Math.min(100, score);
}

// ============================================
// 6. MAIN RUNNER (V10.0 - Universal Fallback)
// ============================================
async function runFileMining(job) {
    console.log(`📂 Starting Universal File Miner v10.0 for Job: ${job.id}`);
    if (!job.file_data) throw new Error("No file data found.");

    const fileBuffer = ensureBuffer(job.file_data);
    console.log(`   📊 Buffer Size: ${fileBuffer.length} bytes`);

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
            } else contacts = mineUnstructuredData(text);
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
        await client.query(`UPDATE mining_jobs SET total_found=$1, total_emails_raw=$2, status='completed', completed_at=NOW(), stats=$3, file_data=NULL WHERE id=$4`, [results.length, totalEmails, summary, job.id]);
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

module.exports = { runFileMining };
