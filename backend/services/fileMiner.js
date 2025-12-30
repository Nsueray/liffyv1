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

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    MAX_SEARCH_LINES_ABOVE: 20,
    MAX_SEARCH_LINES_BELOW: 6,
    MIN_CONFIDENCE: 40,
    PDF_TIMEOUT: 60000,
    MAX_BUFFER: 50 * 1024 * 1024,
    MIN_TEXT_LENGTH: 500
};

// ============================================
// DOMAIN MAPPING
// ============================================
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
    'seweragesystems': 'Sewerage Systems Ghana Ltd',
    'coniwas': 'CONIWAS Ghana',
    'wateraid': 'WaterAid',
    'safewaternetwork': 'Safe Water Network',
    'unicef': 'UNICEF',
    'worldbank': 'The World Bank',
    'undp': 'UNDP',
    'ircwash': 'IRC WASH',
    'wsup': 'Water & Sanitation for the Urban Poor'
};

// ============================================
// REGEX PATTERNS
// ============================================
const PATTERNS = {
    email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi,
    phone: [
        /(?:\+|00)\s?233\s?\(?0?\)?[\s\-\.]?\d{2,3}[\s\-\.]?\d{3}[\s\-\.]?\d{3,4}/g,
        /0[235]\d{1,2}[\s\-\.]?\d{3}[\s\-\.]?\d{4}/g,
        /(?:\+|00)\d{1,3}[\s\-\.]?\(?\d{1,4}\)?[\s\-\.]?\d{3,4}[\s\-\.]?\d{3,4}/g,
        /\(\d{2,4}\)[\s\-\.]?\d{3,4}[\s\-\.]?\d{3,4}/g,
        /\d{3}[\-]\d{3}[\-]\d{4,6}/g,
        /\d{3}\s\d{3}\s\d{4}/g
    ],
    website: [
        /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi,
        /(?:www\.)[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi
    ],
    companyIndicators: /(?:Ltd|Limited|Inc|Corp|Corporation|LLC|GmbH|AG|Company|Co\.|Authority|Agency|Commission|Ministry|Department|Institute|Association|Group|Ventures|Consult|Solutions|Services|Enterprises|Holdings|Bank|Council|Directorate|S\.A\.|PLC|Foundation)/i,
    blacklistUrls: /google\.com|facebook\.com|twitter\.com|linkedin\.com|instagram\.com|youtube\.com|bit\.ly|tinyurl/i
};

// ============================================
// EMAIL ROLE SCORING
// ============================================
const EMAIL_ROLE_SCORES = {
    generic: {
        patterns: ['info@', 'contact@', 'hello@', 'enquiry@', 'enquiries@', 'admin@', 'office@', 'mail@', 'support@'],
        score: 10
    },
    department: {
        patterns: ['sales@', 'marketing@', 'hr@', 'finance@', 'accounts@', 'procurement@', 'operations@', 'technical@', 'export@', 'export1@'],
        score: 15
    },
    personal: { score: 25 }
};

function getEmailRoleScore(email) {
    const lower = email.toLowerCase();
    for (const pattern of EMAIL_ROLE_SCORES.generic.patterns) {
        if (lower.startsWith(pattern)) return EMAIL_ROLE_SCORES.generic.score;
    }
    for (const pattern of EMAIL_ROLE_SCORES.department.patterns) {
        if (lower.startsWith(pattern)) return EMAIL_ROLE_SCORES.department.score;
    }
    return EMAIL_ROLE_SCORES.personal.score;
}

// ============================================
// 1. BUFFER HANDLING
// ============================================
function ensureBuffer(input) {
    console.log("   🔍 Buffer Analysis:");
    console.log(`      Type: ${typeof input}`);
    console.log(`      IsBuffer: ${Buffer.isBuffer(input)}`);
    
    if (Buffer.isBuffer(input)) {
        const magic = input.slice(0, 4).toString('utf8');
        console.log(`      Magic: "${magic}" (${input.slice(0, 4).toString('hex')})`);
        return input;
    }
    
    if (typeof input === 'string') {
        console.log(`      String length: ${input.length}`);
        console.log(`      Starts with: "${input.substring(0, 20)}"`);
        
        if (input.startsWith('\\x')) {
            console.log("      → Converting from Postgres hex format");
            const buf = Buffer.from(input.slice(2), 'hex');
            const magic = buf.slice(0, 4).toString('utf8');
            console.log(`      Magic after conversion: "${magic}"`);
            return buf;
        }
        
        if (input.match(/^[A-Za-z0-9+/=]+$/) && input.length > 100) {
            console.log("      → Converting from Base64");
            return Buffer.from(input, 'base64');
        }
        
        return Buffer.from(input, 'binary');
    }
    
    if (input && input.type === 'Buffer' && Array.isArray(input.data)) {
        console.log("      → Converting from Buffer object");
        return Buffer.from(input.data);
    }

    throw new Error(`Unknown data type: ${typeof input}`);
}

// ============================================
// 2. PDF EXTRACTION - WITH DEBUG
// ============================================
async function extractFromPDF(buffer) {
    const tempPath = path.join(os.tmpdir(), `liffy_${Date.now()}.pdf`);
    
    try {
        await fs.promises.writeFile(tempPath, buffer);
        
        // DEBUG: Temp file kontrolü
        const tempStats = await fs.promises.stat(tempPath);
        console.log(`   📁 Temp file written: ${tempStats.size} bytes (buffer was: ${buffer.length} bytes)`);
        console.log(`   📋 Buffer header (hex): ${buffer.slice(0, 20).toString('hex')}`);
        
        // DEBUG: Temp dosyayı geri oku ve karşılaştır
        const readBack = await fs.promises.readFile(tempPath);
        console.log(`   🔄 Read back: ${readBack.length} bytes, match: ${buffer.equals(readBack)}`);
        
        console.log("   📄 Starting Universal PDF Extraction Chain...");
        
        let text = '';
        let method = '';

        // METHOD 1: pdftotext (Poppler) - STDERR AÇIK
        try {
            console.log("   [1/4] Trying pdftotext...");
            const { stdout, stderr } = await execPromise(
                `pdftotext -layout -enc UTF-8 "${tempPath}" -`,
                { timeout: CONFIG.PDF_TIMEOUT, maxBuffer: CONFIG.MAX_BUFFER }
            );
            
            if (stderr) {
                console.log(`   📝 pdftotext stderr: ${stderr.slice(0, 500)}`);
            }
            
            const realText = stdout.replace(/[\s\f\r\n]/g, '');
            if (realText.length >= CONFIG.MIN_TEXT_LENGTH) {
                text = stdout;
                method = 'pdftotext';
                console.log(`   ✅ pdftotext SUCCESS: ${realText.length} chars`);
            } else {
                console.log(`   ⚠️ pdftotext: Only ${realText.length} chars`);
            }
        } catch (e) {
            console.log(`   ⚠️ pdftotext failed: ${e.message}`);
            if (e.stderr) console.log(`   📝 pdftotext stderr: ${e.stderr.slice(0, 500)}`);
        }

        // METHOD 2: mutool (MuPDF) - STDERR AÇIK
        if (!text) {
            try {
                console.log("   [2/4] Trying mutool...");
                const { stdout, stderr } = await execPromise(
                    `mutool draw -F txt -o - "${tempPath}"`,
                    { timeout: CONFIG.PDF_TIMEOUT, maxBuffer: CONFIG.MAX_BUFFER }
                );
                
                if (stderr) {
                    console.log(`   📝 mutool stderr: ${stderr.slice(0, 500)}`);
                }
                
                const realText = stdout.replace(/[\s\f\r\n]/g, '');
                if (realText.length >= CONFIG.MIN_TEXT_LENGTH) {
                    text = stdout;
                    method = 'mutool';
                    console.log(`   ✅ mutool SUCCESS: ${realText.length} chars`);
                } else {
                    console.log(`   ⚠️ mutool: Only ${realText.length} chars`);
                }
            } catch (e) {
                console.log(`   ⚠️ mutool failed: ${e.message}`);
                if (e.stderr) console.log(`   📝 mutool stderr: ${e.stderr.slice(0, 500)}`);
            }
        }

        // METHOD 3: pdf-parse (JavaScript)
        if (!text && pdfParse) {
            try {
                console.log("   [3/4] Trying pdf-parse...");
                const data = await pdfParse(buffer);
                const realText = data.text.replace(/[\s\f\r\n]/g, '');
                if (realText.length >= CONFIG.MIN_TEXT_LENGTH) {
                    text = data.text;
                    method = 'pdf-parse';
                    console.log(`   ✅ pdf-parse SUCCESS: ${realText.length} chars`);
                } else {
                    console.log(`   ⚠️ pdf-parse: Only ${realText.length} chars`);
                }
            } catch (e) {
                console.log(`   ⚠️ pdf-parse failed: ${e.message}`);
            }
        }

        // METHOD 4: Raw Buffer Scan (Last Resort)
        if (!text) {
            try {
                console.log("   [4/4] Trying raw buffer scan...");
                const rawText = buffer.toString('latin1');
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

        if (text) {
            console.log(`   🎉 PDF Extraction Complete via [${method}]: ${text.length} total chars`);
            return { text, method };
        } else {
            console.error("   ❌ ALL PDF METHODS FAILED");
            return { text: '', method: 'none' };
        }

    } finally {
        try { await fs.promises.unlink(tempPath); } catch (e) {}
    }
}

// ============================================
// 3. EXCEL & WORD READERS
// ============================================
async function extractFromExcel(buffer) {
    if (!xlsx) return { type: 'structured', data: [] };
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
function mineUnstructuredData(text, extractionMethod = 'unknown') {
    const lines = text.split(/\r?\n/);
    const contacts = [];
    const processedEmails = new Set();
    
    const stats = {
        total_lines: lines.length,
        total_emails_found: 0,
        emails_filtered: 0,
        extraction_method: extractionMethod
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const emailMatches = line.match(PATTERNS.email) || [];
        
        for (const email of emailMatches) {
            const emailLower = email.toLowerCase();
            stats.total_emails_found++;
            
            if (processedEmails.has(emailLower)) continue;
            
            if (['.png', '.jpg', '.jpeg', 'example.com', 'wix.com', 'sentry.io'].some(ext => emailLower.includes(ext))) {
                stats.emails_filtered++;
                continue;
            }

            processedEmails.add(emailLower);

            let start = i;
            let searchCount = 0;
            
            while (start > 0 && searchCount < CONFIG.MAX_SEARCH_LINES_ABOVE) {
                start--;
                searchCount++;
                const checkLine = lines[start];
                if (PATTERNS.email.test(checkLine) && !checkLine.toLowerCase().includes(emailLower)) {
                    start++;
                    break;
                }
            }

            let end = i;
            searchCount = 0;
            while (end < lines.length - 1 && searchCount < CONFIG.MAX_SEARCH_LINES_BELOW) {
                end++;
                searchCount++;
                if (PATTERNS.email.test(lines[end]) && !lines[end].toLowerCase().includes(emailLower)) {
                    end--;
                    break;
                }
            }

            const contextLines = lines.slice(start, end + 1);
            const contextText = contextLines.join('\n');

            const company = findCompanyNameSmart(contextLines, i - start, emailLower);
            const phones = extractPhones(contextText);
            const website = extractWebsiteSmart(contextLines, emailLower);
            const country = detectCountry(contextText);
            const addresses = extractAddresses(contextLines);

            const emailRoleScore = getEmailRoleScore(emailLower);
            const confidence = calculateConfidence({ 
                email: emailLower, company, phones, website, addresses, emailRoleScore 
            });

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
                    email_type: classifyEmailType(emailLower),
                    source_type: 'file_unstructured'
                });
            }
        }
    }
    
    return { contacts, stats };
}

// ============================================
// 5. HELPER FUNCTIONS
// ============================================
function findCompanyNameSmart(blockLines, emailRelativeIndex, email) {
    const domain = email.split('@')[1];
    for (const [key, val] of Object.entries(DOMAIN_MAP)) {
        if (domain.includes(key)) return val;
    }

    for (let i = emailRelativeIndex - 1; i >= 0; i--) {
        const line = blockLines[i].trim();
        if (line.length < 3) continue;
        if (/^(Address|Tel|Phone|Email|Web|Fax|Location|P\.?O\.?\s?Box)/i.test(line)) continue;
        if (PATTERNS.companyIndicators.test(line) && line.length < 100) {
            return line.replace(/^(Name|Company|Organization)\s*[:\.]?\s*/i, '').trim();
        }
        if (line === line.toUpperCase() && line.length > 4 && line.length < 60 && /[A-Z]/.test(line)) {
            return line;
        }
    }
    
    return deriveCompanyFromEmail(email);
}

function extractPhones(text) {
    const phones = new Set();
    PATTERNS.phone.forEach(regex => {
        const matches = text.match(regex) || [];
        matches.forEach(p => {
            const clean = p.replace(/[^\d+]/g, '');
            if (clean.length >= 8 && clean.length <= 16 && !/^(19|20)\d{2}$/.test(clean)) {
                phones.add(p.trim());
            }
        });
    });
    return Array.from(phones);
}

function extractWebsiteSmart(lines, email) {
    const emailDomain = email.split('@')[1];
    const candidates = [];

    lines.forEach(line => {
        PATTERNS.website.forEach(regex => {
            const matches = line.match(regex) || [];
            matches.forEach(url => {
                let cleanUrl = url.trim().replace(/[.,;:]+$/, '');
                if (!cleanUrl.startsWith('http')) cleanUrl = 'https://' + cleanUrl;
                if (PATTERNS.blacklistUrls.test(cleanUrl)) return;
                if (cleanUrl.toLowerCase().includes(emailDomain)) {
                    candidates.unshift({ url: cleanUrl, priority: 1 });
                } else {
                    candidates.push({ url: cleanUrl, priority: 2 });
                }
            });
        });
    });

    if (candidates.length > 0) {
        candidates.sort((a, b) => a.priority - b.priority);
        return candidates[0].url;
    }
    
    return deriveWebsiteFromEmail(email);
}

function extractAddresses(contextLines) {
    const addresses = [];
    contextLines.forEach(line => {
        if (/^(Address|Location|P\.?O\.?\s?Box)/i.test(line)) {
            const addr = line.replace(/^(Address|Location)\s*[:\.]?\s*/i, '').trim();
            if (addr.length > 5) addresses.push(addr);
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
        if (['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'].includes(domain)) return "Individual";
        let name = domain.split('.')[0];
        return name.charAt(0).toUpperCase() + name.slice(1);
    } catch (e) { return "Unknown"; }
}

function deriveWebsiteFromEmail(email) {
    try {
        const domain = email.split('@')[1];
        if (['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'].includes(domain)) return null;
        return 'https://www.' + domain;
    } catch (e) { return null; }
}

function detectCountry(text) {
    const search = text.slice(0, 5000).toLowerCase();
    const countries = [
        { name: "Ghana", keywords: ["ghana", "accra", "kumasi"] },
        { name: "Nigeria", keywords: ["nigeria", "lagos", "abuja"] },
        { name: "Kenya", keywords: ["kenya", "nairobi"] },
        { name: "Germany", keywords: ["germany", "berlin", "munich"] },
        { name: "United Kingdom", keywords: ["united kingdom", "uk", "london"] },
        { name: "USA", keywords: ["usa", "united states", "america"] },
        { name: "Turkey", keywords: ["turkey", "türkiye", "istanbul", "ankara", "bursa", "izmir"] },
        { name: "France", keywords: ["france", "paris"] },
        { name: "China", keywords: ["china", "beijing", "shanghai"] }
    ];
    
    for (const c of countries) {
        if (c.keywords.some(kw => search.includes(kw))) return c.name;
    }
    return null;
}

function classifyEmailType(email) {
    const lower = email.toLowerCase();
    if (EMAIL_ROLE_SCORES.generic.patterns.some(p => lower.startsWith(p))) return 'generic';
    if (EMAIL_ROLE_SCORES.department.patterns.some(p => lower.startsWith(p))) return 'department';
    return 'personal';
}

function calculateConfidence(data) {
    let score = 30;
    score += data.emailRoleScore || 15;
    if (data.phones && data.phones.length > 0) score += 15;
    if (data.website) score += 10;
    if (data.company && data.company !== "Individual" && data.company !== "Unknown") score += 15;
    if (data.addresses && data.addresses.length > 0) score += 5;
    return Math.min(100, score);
}

// ============================================
// 6. STRUCTURED DATA MINING (Excel)
// ============================================
function mineStructuredData(sheetsData) {
    const contacts = [];
    const processedEmails = new Set();
    
    sheetsData.forEach(rows => {
        if (!Array.isArray(rows)) return;
        rows.forEach(row => {
            if (!Array.isArray(row)) return;
            let email = null, company = null;
            const rowText = row.join(' ');
            
            row.forEach(cell => {
                const str = String(cell);
                if (PATTERNS.email.test(str)) {
                    const match = str.match(PATTERNS.email);
                    if (match) email = match[0];
                }
            });

            if (email && !processedEmails.has(email.toLowerCase())) {
                processedEmails.add(email.toLowerCase());
                const phones = extractPhones(rowText);
                row.forEach(cell => {
                    const str = String(cell);
                    if (str.length > 3 && PATTERNS.companyIndicators.test(str) && !PATTERNS.email.test(str)) {
                        company = str;
                    }
                });
                if (!company) company = deriveCompanyFromEmail(email.toLowerCase());
                const emailRoleScore = getEmailRoleScore(email.toLowerCase());
                
                contacts.push({
                    email: email.toLowerCase(),
                    companyName: company,
                    phone: phones[0] || null,
                    website: deriveWebsiteFromEmail(email),
                    country: detectCountry(rowText),
                    all_phones: phones,
                    confidence: 85 + (emailRoleScore > 20 ? 10 : 0),
                    email_type: classifyEmailType(email),
                    source_type: 'file_structured'
                });
            }
        });
    });
    return { contacts, stats: { extraction_method: 'excel' } };
}

// ============================================
// 7. FILE SUMMARY OBJECT
// ============================================
function generateFileSummary(contacts, extractionStats, filename) {
    const allText = contacts.map(c => `${c.companyName} ${c.email}`).join(' ').toLowerCase();
    let sector = 'general';
    if (allText.includes('water') || allText.includes('sanitation')) sector = 'water_sanitation';
    else if (allText.includes('energy') || allText.includes('power')) sector = 'energy';
    else if (allText.includes('health') || allText.includes('medical')) sector = 'healthcare';
    else if (allText.includes('tech') || allText.includes('software')) sector = 'technology';
    else if (allText.includes('hvac') || allText.includes('air') || allText.includes('fan')) sector = 'hvac';
    
    const countries = contacts.map(c => c.country).filter(Boolean);
    const mainCountry = countries.length > 0 
        ? countries.sort((a,b) => countries.filter(v => v===a).length - countries.filter(v => v===b).length).pop()
        : null;
    
    const emailTypes = {
        generic: contacts.filter(c => c.email_type === 'generic').length,
        department: contacts.filter(c => c.email_type === 'department').length,
        personal: contacts.filter(c => c.email_type === 'personal').length
    };
    
    const personalRatio = contacts.length > 0 ? emailTypes.personal / contacts.length : 0;
    const hasPhones = contacts.filter(c => c.phone).length;
    const phoneRatio = contacts.length > 0 ? hasPhones / contacts.length : 0;
    
    const businessRelevanceScore = Math.round(
        (personalRatio * 40) + (phoneRatio * 30) + 
        (contacts.length > 10 ? 20 : contacts.length * 2) + (mainCountry ? 10 : 0)
    );

    return {
        filename, document_type: extractionStats.extraction_method === 'excel' ? 'spreadsheet' : 'document',
        extraction_method: extractionStats.extraction_method, main_country: mainCountry,
        detected_sector: sector, total_organizations: new Set(contacts.map(c => c.companyName)).size,
        total_contacts: contacts.length, contacts_with_phone: hasPhones,
        email_type_distribution: emailTypes, business_relevance_score: Math.min(100, businessRelevanceScore),
        extraction_stats: extractionStats
    };
}

// ============================================
// 8. MAIN RUNNER (V11.1 DEBUG)
// ============================================
async function runFileMining(job) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`📂 LIFFY FILE MINER V11.1 (DEBUG)`);
    console.log(`Job: ${job.id}`);
    console.log(`File: ${job.input}`);
    console.log(`${'='.repeat(50)}`);
    
    if (!job.file_data) throw new Error("No file data found.");

    const fileBuffer = ensureBuffer(job.file_data);
    console.log(`   📊 Buffer Size: ${fileBuffer.length} bytes`);
    
    const magic = fileBuffer.slice(0, 8).toString('utf8');
    console.log(`   📋 Magic: "${magic.replace(/[^\x20-\x7E]/g, '?')}"`);

    const filename = job.input.toLowerCase();
    let contacts = [];
    let extractionStats = {};

    try {
        if (filename.endsWith('.pdf')) {
            const { text, method } = await extractFromPDF(fileBuffer);
            const result = mineUnstructuredData(text, method);
            contacts = result.contacts;
            extractionStats = result.stats;
            
        } else if (filename.endsWith('.xlsx') || filename.endsWith('.xls')) {
            const excelData = await extractFromExcel(fileBuffer);
            if (excelData.type === 'structured') {
                const result = mineStructuredData(excelData.data);
                contacts = result.contacts;
                extractionStats = result.stats;
            }
            
        } else if (filename.endsWith('.docx') || filename.endsWith('.doc')) {
            const text = await extractFromWord(fileBuffer);
            const result = mineUnstructuredData(text, 'word');
            contacts = result.contacts;
            extractionStats = result.stats;
            
        } else {
            const text = fileBuffer.toString('utf8');
            if ((text.match(/,/g) || []).length > text.split('\n').length) {
                const rows = text.split('\n').map(r => r.split(/,|;/));
                const result = mineStructuredData([rows]);
                contacts = result.contacts;
                extractionStats = result.stats;
            } else {
                const result = mineUnstructuredData(text, 'text');
                contacts = result.contacts;
                extractionStats = result.stats;
            }
        }

        const summary = generateFileSummary(contacts, extractionStats, job.input);
        
        console.log(`\n   📊 SUMMARY:`);
        console.log(`      Contacts: ${summary.total_contacts}`);
        console.log(`      With Phone: ${summary.contacts_with_phone}`);
        console.log(`      Organizations: ${summary.total_organizations}`);
        console.log(`      Business Score: ${summary.business_relevance_score}/100`);
        console.log(`      Method: ${summary.extraction_method}`);

        await saveResultsToDb(job, contacts, summary);
        
        console.log(`\n   ✅ Mining Complete!`);
        console.log(`${'='.repeat(50)}\n`);
        
    } catch (err) {
        console.error("❌ Critical Miner Error:", err);
        throw err;
    }
}

async function saveResultsToDb(job, results, summary) {
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
        
        await client.query(`
            UPDATE mining_jobs 
            SET total_found = $1, total_emails_raw = $2, status = 'completed',
                completed_at = NOW(), stats = $3, file_data = NULL
            WHERE id = $4
        `, [results.length, totalEmails, summary, job.id]);
        
        await client.query('COMMIT');
        console.log(`   💾 Saved ${results.length} contacts to DB`);
        
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

module.exports = { runFileMining };
