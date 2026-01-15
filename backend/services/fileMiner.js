const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const db = require('../db');

// --- KÜTÜPHANELER (Lazy Load) ---
let xlsx, mammoth, pdfParse;
try { xlsx = require('xlsx'); } catch(e) { console.log('xlsx not available'); }
try { mammoth = require('mammoth'); } catch(e) { console.log('mammoth not available'); }
try { pdfParse = require('pdf-parse'); } catch(e) { console.log('pdf-parse not available'); }

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    PDF_TIMEOUT: 60000,
    MAX_BUFFER: 50 * 1024 * 1024,
    MIN_TEXT_LENGTH: 50, // Düşürüldü - küçük dosyalar için
    MIN_CONFIDENCE: 30,  // Düşürüldü - daha fazla sonuç için
};

// ============================================
// REGEX PATTERNS
// ============================================
const PATTERNS = {
    // Email pattern - daha geniş
    email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi,
    
    // Phone patterns - international focus
    phone: [
        // Turkish format: +90 533 209 5377
        /(?:\+|00)?90[\s\-\.]?\d{3}[\s\-\.]?\d{3}[\s\-\.]?\d{2}[\s\-\.]?\d{2}/g,
        // Generic international: +1 234 567 8900
        /(?:\+|00)\d{1,3}[\s\-\.]?\(?\d{1,4}\)?[\s\-\.]?\d{2,4}[\s\-\.]?\d{2,4}[\s\-\.]?\d{2,4}/g,
        // Standard formats
        /\d{3}[\s\-\.]\d{3}[\s\-\.]\d{4}/g,
        /\(\d{3}\)[\s\-\.]?\d{3}[\s\-\.]?\d{4}/g,
    ],
    
    // URL pattern
    website: /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi,
    
    // Structured label patterns (case insensitive)
    labels: {
        company: /^(?:company|organization|organisation|firm|şirket|firma)[\s]*[:\-][\s]*/i,
        name: /^(?:name|contact|person|isim|ad|kişi|contact\s*name|representative)[\s]*[:\-][\s]*/i,
        email: /^(?:email|e-mail|mail|e-posta|eposta)[\s]*[:\-][\s]*/i,
        phone: /^(?:phone|tel|telephone|mobile|cell|gsm|telefon|cep)[\s]*[:\-][\s]*/i,
        country: /^(?:country|nation|ülke|location|lokasyon)[\s]*[:\-][\s]*/i,
        city: /^(?:city|şehir|town|il)[\s]*[:\-][\s]*/i,
        address: /^(?:address|adres|location)[\s]*[:\-][\s]*/i,
        website: /^(?:website|web|site|url|www)[\s]*[:\-][\s]*/i,
        title: /^(?:title|position|job\s*title|role|pozisyon|ünvan|görev)[\s]*[:\-][\s]*/i,
    },
    
    // Blacklist for emails
    emailBlacklist: ['.png', '.jpg', '.jpeg', '.gif', '.svg', 'example.com', 'test.com', 'wix.com', 'sentry.io', 'noreply', 'no-reply'],
    
    // Generic email providers
    genericProviders: ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'mail.com', 'yandex.com', 'protonmail.com'],
};

// ============================================
// COUNTRY DATABASE
// ============================================
const COUNTRIES = [
    { name: "Turkey", keywords: ["turkey", "türkiye", "turkiye", "istanbul", "ankara", "izmir", "bursa", "antalya", "+90"] },
    { name: "Ghana", keywords: ["ghana", "accra", "kumasi", "+233"] },
    { name: "Nigeria", keywords: ["nigeria", "lagos", "abuja", "+234"] },
    { name: "Kenya", keywords: ["kenya", "nairobi", "mombasa", "+254"] },
    { name: "South Africa", keywords: ["south africa", "johannesburg", "cape town", "pretoria", "+27"] },
    { name: "United Kingdom", keywords: ["united kingdom", "uk", "england", "london", "manchester", "+44"] },
    { name: "USA", keywords: ["usa", "united states", "america", "new york", "california", "texas", "+1"] },
    { name: "Germany", keywords: ["germany", "deutschland", "berlin", "munich", "frankfurt", "+49"] },
    { name: "France", keywords: ["france", "paris", "lyon", "marseille", "+33"] },
    { name: "Italy", keywords: ["italy", "italia", "rome", "milan", "roma", "+39"] },
    { name: "Spain", keywords: ["spain", "españa", "madrid", "barcelona", "+34"] },
    { name: "Netherlands", keywords: ["netherlands", "holland", "amsterdam", "rotterdam", "+31"] },
    { name: "UAE", keywords: ["uae", "dubai", "abu dhabi", "emirates", "+971"] },
    { name: "Saudi Arabia", keywords: ["saudi", "riyadh", "jeddah", "+966"] },
    { name: "China", keywords: ["china", "beijing", "shanghai", "guangzhou", "+86"] },
    { name: "India", keywords: ["india", "mumbai", "delhi", "bangalore", "+91"] },
    { name: "Brazil", keywords: ["brazil", "brasil", "são paulo", "rio", "+55"] },
    { name: "Mexico", keywords: ["mexico", "méxico", "mexico city", "+52"] },
    { name: "Canada", keywords: ["canada", "toronto", "vancouver", "montreal", "+1"] },
    { name: "Australia", keywords: ["australia", "sydney", "melbourne", "brisbane", "+61"] },
];

// ============================================
// 1. BUFFER HANDLING (IMPROVED)
// ============================================
function ensureBuffer(input) {
    console.log("   🔍 Buffer Analysis:");
    console.log(`      Type: ${typeof input}`);
    console.log(`      IsBuffer: ${Buffer.isBuffer(input)}`);
    
    if (Buffer.isBuffer(input)) {
        console.log(`      Size: ${input.length} bytes`);
        const magic = input.slice(0, 4).toString('hex');
        console.log(`      Magic (hex): ${magic}`);
        return input;
    }
    
    if (typeof input === 'string') {
        console.log(`      String length: ${input.length}`);
        
        // PostgreSQL bytea hex format: \x...
        if (input.startsWith('\\x')) {
            console.log("      → Converting from Postgres hex format (\\x)");
            const hexStr = input.slice(2);
            const buf = Buffer.from(hexStr, 'hex');
            console.log(`      Converted size: ${buf.length} bytes`);
            return buf;
        }
        
        // Base64 encoded
        if (input.match(/^[A-Za-z0-9+/=]+$/) && input.length > 100) {
            console.log("      → Converting from Base64");
            return Buffer.from(input, 'base64');
        }
        
        // Raw binary string
        console.log("      → Converting from binary string");
        return Buffer.from(input, 'binary');
    }
    
    // Buffer-like object {type: 'Buffer', data: [...]}
    if (input && input.type === 'Buffer' && Array.isArray(input.data)) {
        console.log("      → Converting from Buffer object");
        return Buffer.from(input.data);
    }
    
    // Uint8Array
    if (input instanceof Uint8Array) {
        console.log("      → Converting from Uint8Array");
        return Buffer.from(input);
    }

    throw new Error(`Unknown data type: ${typeof input}, cannot convert to Buffer`);
}

// ============================================
// 2. TEXT EXTRACTION - PDF
// ============================================
async function extractTextFromPDF(buffer) {
    const tempPath = path.join(os.tmpdir(), `liffy_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`);
    
    try {
        await fs.promises.writeFile(tempPath, buffer);
        const stats = await fs.promises.stat(tempPath);
        console.log(`   📁 Temp PDF written: ${stats.size} bytes`);
        
        let text = '';
        let method = 'none';

        // METHOD 1: pdftotext (Poppler) - Best for text-based PDFs
        try {
            console.log("   [1/4] Trying pdftotext...");
            const { stdout, stderr } = await execPromise(
                `pdftotext -layout -enc UTF-8 "${tempPath}" -`,
                { timeout: CONFIG.PDF_TIMEOUT, maxBuffer: CONFIG.MAX_BUFFER }
            );
            
            const cleanText = stdout.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''); // Remove control chars
            if (cleanText.trim().length >= CONFIG.MIN_TEXT_LENGTH) {
                text = cleanText;
                method = 'pdftotext';
                console.log(`   ✅ pdftotext SUCCESS: ${text.length} chars`);
            } else {
                console.log(`   ⚠️ pdftotext: Only ${cleanText.trim().length} chars (min: ${CONFIG.MIN_TEXT_LENGTH})`);
            }
        } catch (e) {
            console.log(`   ⚠️ pdftotext failed: ${e.message.slice(0, 100)}`);
        }

        // METHOD 2: mutool (MuPDF) - Good for complex PDFs
        if (!text) {
            try {
                console.log("   [2/4] Trying mutool...");
                const { stdout } = await execPromise(
                    `mutool draw -F txt -o - "${tempPath}"`,
                    { timeout: CONFIG.PDF_TIMEOUT, maxBuffer: CONFIG.MAX_BUFFER }
                );
                
                const cleanText = stdout.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
                if (cleanText.trim().length >= CONFIG.MIN_TEXT_LENGTH) {
                    text = cleanText;
                    method = 'mutool';
                    console.log(`   ✅ mutool SUCCESS: ${text.length} chars`);
                } else {
                    console.log(`   ⚠️ mutool: Only ${cleanText.trim().length} chars`);
                }
            } catch (e) {
                console.log(`   ⚠️ mutool failed: ${e.message.slice(0, 100)}`);
            }
        }

        // METHOD 3: pdf-parse (JavaScript) - Fallback
        if (!text && pdfParse) {
            try {
                console.log("   [3/4] Trying pdf-parse...");
                const data = await pdfParse(buffer, { max: 0 }); // No page limit
                const cleanText = data.text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
                if (cleanText.trim().length >= CONFIG.MIN_TEXT_LENGTH) {
                    text = cleanText;
                    method = 'pdf-parse';
                    console.log(`   ✅ pdf-parse SUCCESS: ${text.length} chars`);
                } else {
                    console.log(`   ⚠️ pdf-parse: Only ${cleanText.trim().length} chars`);
                }
            } catch (e) {
                console.log(`   ⚠️ pdf-parse failed: ${e.message.slice(0, 100)}`);
            }
        }

        // METHOD 4: Raw text extraction (Last Resort)
        if (!text) {
            try {
                console.log("   [4/4] Trying raw extraction...");
                // Try to find readable text in PDF stream
                const rawStr = buffer.toString('latin1');
                
                // Extract text between parentheses (PDF text objects)
                const textMatches = rawStr.match(/\(([^)]{2,})\)/g) || [];
                let extracted = textMatches
                    .map(m => m.slice(1, -1))
                    .filter(t => t.length > 2 && /[a-zA-Z@]/.test(t))
                    .join(' ');
                
                // Also try to find BT...ET text blocks
                const btMatches = rawStr.match(/BT[\s\S]*?ET/g) || [];
                for (const block of btMatches) {
                    const tjMatches = block.match(/\[([^\]]+)\]\s*TJ/g) || [];
                    for (const tj of tjMatches) {
                        const parts = tj.match(/\(([^)]+)\)/g) || [];
                        extracted += ' ' + parts.map(p => p.slice(1, -1)).join('');
                    }
                }
                
                if (extracted.trim().length >= 20) {
                    text = extracted;
                    method = 'raw-extraction';
                    console.log(`   ✅ raw-extraction SUCCESS: ${text.length} chars`);
                }
            } catch (e) {
                console.log(`   ⚠️ raw-extraction failed: ${e.message.slice(0, 100)}`);
            }
        }

        return { text: text || '', method };
        
    } finally {
        try { await fs.promises.unlink(tempPath); } catch (e) {}
    }
}

// ============================================
// 3. TEXT EXTRACTION - WORD (DOCX)
// ============================================
async function extractTextFromWord(buffer) {
    console.log("   📄 Extracting text from Word document...");
    
    // METHOD 1: mammoth (Best for DOCX)
    if (mammoth) {
        try {
            console.log("   [1/3] Trying mammoth...");
            const result = await mammoth.extractRawText({ buffer: buffer });
            if (result.value && result.value.trim().length > 0) {
                console.log(`   ✅ mammoth SUCCESS: ${result.value.length} chars`);
                return { text: result.value, method: 'mammoth' };
            }
        } catch (e) {
            console.log(`   ⚠️ mammoth failed: ${e.message.slice(0, 100)}`);
        }
    }
    
    // METHOD 2: unzip + xml parse (Manual DOCX extraction)
    try {
        console.log("   [2/3] Trying manual DOCX extraction...");
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(buffer);
        const documentXml = zip.getEntry('word/document.xml');
        
        if (documentXml) {
            let xmlContent = documentXml.getData().toString('utf8');
            // Remove XML tags, keep text content
            let text = xmlContent
                .replace(/<w:t[^>]*>([^<]*)<\/w:t>/g, '$1 ')
                .replace(/<[^>]+>/g, '')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&')
                .replace(/&quot;/g, '"')
                .replace(/\s+/g, ' ')
                .trim();
            
            if (text.length > 0) {
                console.log(`   ✅ manual-docx SUCCESS: ${text.length} chars`);
                return { text, method: 'manual-docx' };
            }
        }
    } catch (e) {
        console.log(`   ⚠️ manual-docx failed: ${e.message.slice(0, 100)}`);
    }
    
    // METHOD 3: Raw string search
    try {
        console.log("   [3/3] Trying raw string extraction...");
        const rawStr = buffer.toString('utf8');
        // Find email-like patterns and surrounding text
        const emailMatches = rawStr.match(PATTERNS.email) || [];
        if (emailMatches.length > 0) {
            console.log(`   ✅ raw-string: Found ${emailMatches.length} emails in raw content`);
            return { text: rawStr, method: 'raw-string' };
        }
    } catch (e) {
        console.log(`   ⚠️ raw-string failed: ${e.message.slice(0, 100)}`);
    }
    
    return { text: '', method: 'none' };
}

// ============================================
// 4. TEXT EXTRACTION - EXCEL
// ============================================
async function extractFromExcel(buffer) {
    if (!xlsx) {
        console.log("   ⚠️ xlsx library not available");
        return { type: 'structured', sheets: [], text: '' };
    }
    
    try {
        console.log("   📊 Extracting from Excel...");
        const workbook = xlsx.read(buffer, { type: 'buffer' });
        
        const sheets = [];
        let allText = '';
        
        for (const sheetName of workbook.SheetNames) {
            const sheet = workbook.Sheets[sheetName];
            const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
            sheets.push({ name: sheetName, rows });
            
            // Convert to text for unstructured parsing too
            for (const row of rows) {
                allText += row.join(' ') + '\n';
            }
        }
        
        console.log(`   ✅ Excel extracted: ${sheets.length} sheets, ${allText.length} chars`);
        return { type: 'structured', sheets, text: allText };
        
    } catch (e) {
        console.log(`   ⚠️ Excel extraction failed: ${e.message}`);
        return { type: 'structured', sheets: [], text: '' };
    }
}

// ============================================
// 5. STRUCTURED TEXT PARSER
// ============================================
function parseStructuredText(text) {
    const contacts = [];
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    
    console.log(`   📝 Parsing ${lines.length} lines for structured data...`);
    
    let currentContact = {};
    let lastLabel = null;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Check each label pattern
        for (const [field, pattern] of Object.entries(PATTERNS.labels)) {
            if (pattern.test(line)) {
                const value = line.replace(pattern, '').trim();
                
                // Clean up markdown/html artifacts
                const cleanValue = value
                    .replace(/\[([^\]]+)\]\{[^}]*\}/g, '$1') // Remove markdown links
                    .replace(/\[[^\]]*\]\([^)]*\)/g, '')      // Remove inline links
                    .replace(/<[^>]+>/g, '')                   // Remove HTML tags
                    .trim();
                
                if (cleanValue.length > 0) {
                    // If we hit a new "company" or "name" and we have data, save previous contact
                    if ((field === 'company' || field === 'name') && 
                        (currentContact.email || currentContact.company || currentContact.name)) {
                        
                        // Check if this is actually new data or continuation
                        if (currentContact[field] && currentContact[field] !== cleanValue) {
                            // New contact block starting
                            if (Object.keys(currentContact).length > 0) {
                                contacts.push({ ...currentContact });
                            }
                            currentContact = {};
                        }
                    }
                    
                    currentContact[field] = cleanValue;
                    lastLabel = field;
                }
                break;
            }
        }
        
        // Handle continuation lines (value without label on next line)
        if (lastLabel && !Object.values(PATTERNS.labels).some(p => p.test(line))) {
            // Check if this line is a value (not starting with common labels)
            const isLikelyValue = line.length > 0 && 
                                  line.length < 200 && 
                                  !line.includes(':') &&
                                  !/^(company|name|email|phone|country|city|address|website|title)/i.test(line);
            
            if (isLikelyValue && !currentContact[lastLabel]) {
                currentContact[lastLabel] = line;
            }
        }
    }
    
    // Don't forget the last contact
    if (Object.keys(currentContact).length > 0) {
        contacts.push(currentContact);
    }
    
    console.log(`   📊 Structured parser found ${contacts.length} potential contacts`);
    return contacts;
}

// ============================================
// 6. EMAIL-CENTRIC EXTRACTION
// ============================================
function extractContactsAroundEmails(text) {
    const contacts = [];
    const lines = text.split(/\r?\n/);
    const processedEmails = new Set();
    
    console.log(`   📧 Searching for emails in ${lines.length} lines...`);
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const emailMatches = line.match(PATTERNS.email) || [];
        
        for (const email of emailMatches) {
            const emailLower = email.toLowerCase();
            
            // Skip duplicates and blacklisted
            if (processedEmails.has(emailLower)) continue;
            if (PATTERNS.emailBlacklist.some(bl => emailLower.includes(bl))) continue;
            
            processedEmails.add(emailLower);
            
            // Get context (lines above and below)
            const contextStart = Math.max(0, i - 10);
            const contextEnd = Math.min(lines.length - 1, i + 5);
            const contextLines = lines.slice(contextStart, contextEnd + 1);
            const contextText = contextLines.join('\n');
            
            // Extract data from context
            const contact = {
                email: emailLower,
                company: extractField(contextLines, 'company'),
                name: extractField(contextLines, 'name'),
                phone: extractPhoneFromText(contextText),
                country: detectCountry(contextText),
                city: extractField(contextLines, 'city'),
                address: extractField(contextLines, 'address'),
                website: extractWebsite(contextText, emailLower),
                title: extractField(contextLines, 'title'),
            };
            
            contacts.push(contact);
        }
    }
    
    console.log(`   📊 Email-centric extraction found ${contacts.length} contacts`);
    return contacts;
}

// ============================================
// 7. HELPER EXTRACTION FUNCTIONS
// ============================================
function extractField(lines, fieldName) {
    const pattern = PATTERNS.labels[fieldName];
    if (!pattern) return null;
    
    for (const line of lines) {
        if (pattern.test(line)) {
            let value = line.replace(pattern, '').trim();
            // Clean up
            value = value
                .replace(/\[([^\]]+)\]\{[^}]*\}/g, '$1')
                .replace(/\[[^\]]*\]\([^)]*\)/g, '')
                .replace(/<[^>]+>/g, '')
                .trim();
            
            if (value.length > 0 && value.length < 200) {
                return value;
            }
        }
    }
    return null;
}

function extractPhoneFromText(text) {
    for (const pattern of PATTERNS.phone) {
        const matches = text.match(pattern);
        if (matches && matches.length > 0) {
            // Clean and validate
            const phone = matches[0].trim();
            const digits = phone.replace(/\D/g, '');
            if (digits.length >= 8 && digits.length <= 15) {
                return phone;
            }
        }
    }
    return null;
}

function detectCountry(text) {
    const lowerText = text.toLowerCase();
    
    for (const country of COUNTRIES) {
        for (const keyword of country.keywords) {
            if (lowerText.includes(keyword.toLowerCase())) {
                return country.name;
            }
        }
    }
    return null;
}

function extractWebsite(text, email) {
    // First try to find explicit URL
    const urlMatches = text.match(PATTERNS.website);
    if (urlMatches) {
        for (const url of urlMatches) {
            // Skip social media and generic sites
            if (!/facebook|twitter|linkedin|instagram|youtube/i.test(url)) {
                return url;
            }
        }
    }
    
    // Derive from email domain
    if (email) {
        const parts = email.split('@');
        if (parts.length === 2) {
            const domain = parts[1].toLowerCase();
            if (!PATTERNS.genericProviders.includes(domain)) {
                return `https://www.${domain}`;
            }
        }
    }
    
    return null;
}

// ============================================
// 8. MERGE & DEDUPLICATE CONTACTS
// ============================================
function mergeContacts(structuredContacts, emailCentricContacts) {
    const emailMap = new Map();
    
    // Process structured contacts first (higher priority)
    for (const contact of structuredContacts) {
        if (contact.email) {
            const key = contact.email.toLowerCase();
            if (!emailMap.has(key)) {
                emailMap.set(key, { ...contact, email: key });
            } else {
                // Merge: fill in missing fields
                const existing = emailMap.get(key);
                for (const [field, value] of Object.entries(contact)) {
                    if (value && !existing[field]) {
                        existing[field] = value;
                    }
                }
            }
        }
    }
    
    // Add email-centric contacts
    for (const contact of emailCentricContacts) {
        if (contact.email) {
            const key = contact.email.toLowerCase();
            if (!emailMap.has(key)) {
                emailMap.set(key, { ...contact });
            } else {
                // Merge
                const existing = emailMap.get(key);
                for (const [field, value] of Object.entries(contact)) {
                    if (value && !existing[field]) {
                        existing[field] = value;
                    }
                }
            }
        }
    }
    
    // Convert to array and calculate confidence
    const results = [];
    for (const contact of emailMap.values()) {
        const confidence = calculateConfidence(contact);
        if (confidence >= CONFIG.MIN_CONFIDENCE) {
            results.push({
                ...contact,
                confidence,
                source_type: 'file_mining'
            });
        }
    }
    
    // Sort by confidence
    results.sort((a, b) => b.confidence - a.confidence);
    
    console.log(`   ✅ Merged ${results.length} unique contacts`);
    return results;
}

// ============================================
// 9. CONFIDENCE SCORING
// ============================================
function calculateConfidence(contact) {
    let score = 0;
    
    // Email is mandatory - base score
    if (contact.email) {
        score += 30;
        
        // Personal email vs generic
        const emailLower = contact.email.toLowerCase();
        const isGeneric = ['info@', 'contact@', 'hello@', 'admin@', 'support@', 'sales@', 'office@'].some(p => emailLower.startsWith(p));
        if (!isGeneric) score += 15;
    } else {
        return 0; // No email = no contact
    }
    
    // Additional fields
    if (contact.name && contact.name.length > 2) score += 20;
    if (contact.company && contact.company.length > 2) score += 15;
    if (contact.phone) score += 15;
    if (contact.country) score += 5;
    if (contact.website) score += 5;
    if (contact.title) score += 5;
    if (contact.city) score += 3;
    if (contact.address) score += 2;
    
    return Math.min(100, score);
}

// ============================================
// 10. EXCEL STRUCTURED MINING
// ============================================
function mineExcelStructured(sheets) {
    const contacts = [];
    const processedEmails = new Set();
    
    console.log(`   📊 Mining ${sheets.length} Excel sheets...`);
    
    for (const sheet of sheets) {
        const { rows } = sheet;
        if (!rows || rows.length === 0) continue;
        
        // Try to detect header row
        let headerRow = null;
        let headerIndex = -1;
        
        for (let i = 0; i < Math.min(5, rows.length); i++) {
            const row = rows[i].map(c => String(c).toLowerCase());
            const hasEmail = row.some(c => c.includes('email') || c.includes('e-mail'));
            const hasName = row.some(c => c.includes('name') || c.includes('contact'));
            
            if (hasEmail || hasName) {
                headerRow = rows[i].map(c => String(c).toLowerCase().trim());
                headerIndex = i;
                break;
            }
        }
        
        // Map columns
        const colMap = {};
        if (headerRow) {
            headerRow.forEach((header, idx) => {
                if (header.includes('email') || header.includes('e-mail')) colMap.email = idx;
                else if (header.includes('company') || header.includes('organization') || header.includes('firm')) colMap.company = idx;
                else if (header.includes('name') || header.includes('contact')) colMap.name = idx;
                else if (header.includes('phone') || header.includes('tel') || header.includes('mobile')) colMap.phone = idx;
                else if (header.includes('country')) colMap.country = idx;
                else if (header.includes('city')) colMap.city = idx;
                else if (header.includes('website') || header.includes('url')) colMap.website = idx;
                else if (header.includes('title') || header.includes('position')) colMap.title = idx;
                else if (header.includes('address')) colMap.address = idx;
            });
        }
        
        // Process data rows
        const startRow = headerIndex >= 0 ? headerIndex + 1 : 0;
        
        for (let i = startRow; i < rows.length; i++) {
            const row = rows[i];
            
            // Find email in row (either by column mapping or by searching)
            let email = null;
            if (colMap.email !== undefined) {
                email = String(row[colMap.email] || '').trim();
            }
            
            // If no email from mapping, search all cells
            if (!email || !PATTERNS.email.test(email)) {
                for (const cell of row) {
                    const cellStr = String(cell);
                    const matches = cellStr.match(PATTERNS.email);
                    if (matches) {
                        email = matches[0];
                        break;
                    }
                }
            }
            
            // Validate email
            if (!email || !PATTERNS.email.test(email)) continue;
            
            const emailLower = email.toLowerCase();
            if (processedEmails.has(emailLower)) continue;
            if (PATTERNS.emailBlacklist.some(bl => emailLower.includes(bl))) continue;
            
            processedEmails.add(emailLower);
            
            // Extract other fields
            const rowText = row.join(' ');
            const contact = {
                email: emailLower,
                company: colMap.company !== undefined ? String(row[colMap.company] || '').trim() : null,
                name: colMap.name !== undefined ? String(row[colMap.name] || '').trim() : null,
                phone: colMap.phone !== undefined ? String(row[colMap.phone] || '').trim() : extractPhoneFromText(rowText),
                country: colMap.country !== undefined ? String(row[colMap.country] || '').trim() : detectCountry(rowText),
                city: colMap.city !== undefined ? String(row[colMap.city] || '').trim() : null,
                website: colMap.website !== undefined ? String(row[colMap.website] || '').trim() : extractWebsite(rowText, emailLower),
                title: colMap.title !== undefined ? String(row[colMap.title] || '').trim() : null,
                address: colMap.address !== undefined ? String(row[colMap.address] || '').trim() : null,
            };
            
            // Clean empty strings to null
            for (const key of Object.keys(contact)) {
                if (contact[key] === '') contact[key] = null;
            }
            
            contacts.push(contact);
        }
    }
    
    console.log(`   📊 Excel mining found ${contacts.length} contacts`);
    return contacts;
}

// ============================================
// 11. MAIN FILE PROCESSOR
// ============================================
async function processFile(buffer, filename) {
    const ext = path.extname(filename).toLowerCase();
    console.log(`\n   📂 Processing file: ${filename} (${ext})`);
    console.log(`   📊 Buffer size: ${buffer.length} bytes`);
    
    let text = '';
    let method = 'unknown';
    let excelData = null;
    
    // Extract text based on file type
    if (ext === '.pdf') {
        const result = await extractTextFromPDF(buffer);
        text = result.text;
        method = result.method;
        
    } else if (ext === '.docx' || ext === '.doc') {
        const result = await extractTextFromWord(buffer);
        text = result.text;
        method = result.method;
        
    } else if (ext === '.xlsx' || ext === '.xls') {
        excelData = await extractFromExcel(buffer);
        text = excelData.text;
        method = 'excel';
        
    } else if (ext === '.csv' || ext === '.tsv') {
        text = buffer.toString('utf8');
        method = 'csv';
        
    } else if (ext === '.txt' || ext === '.text') {
        text = buffer.toString('utf8');
        method = 'text';
        
    } else {
        // Try as text
        try {
            text = buffer.toString('utf8');
            method = 'auto-text';
        } catch (e) {
            console.log(`   ⚠️ Could not read file as text: ${e.message}`);
        }
    }
    
    console.log(`   📝 Extraction method: ${method}`);
    console.log(`   📝 Extracted text length: ${text.length} chars`);
    
    // Parse contacts
    let contacts = [];
    
    // Method 1: Excel structured mining
    if (excelData && excelData.sheets && excelData.sheets.length > 0) {
        const excelContacts = mineExcelStructured(excelData.sheets);
        contacts = contacts.concat(excelContacts);
    }
    
    // Method 2: Structured text parsing
    if (text.length > 0) {
        const structuredContacts = parseStructuredText(text);
        const emailCentricContacts = extractContactsAroundEmails(text);
        
        // Merge all contacts
        contacts = mergeContacts(
            [...contacts, ...structuredContacts],
            emailCentricContacts
        );
    }
    
    return {
        contacts,
        stats: {
            extraction_method: method,
            text_length: text.length,
            total_contacts: contacts.length,
            filename: filename
        }
    };
}

// ============================================
// 12. DATABASE SAVE
// ============================================
async function saveResultsToDb(job, contacts, stats) {
    const client = await db.connect();
    
    try {
        await client.query('BEGIN');
        
        let savedCount = 0;
        let totalEmails = 0;
        
        for (const contact of contacts) {
            // Ensure email is an array
            const emails = contact.email ? [contact.email] : [];
            totalEmails += emails.length;
            
            await client.query(`
                INSERT INTO mining_results 
                (job_id, organizer_id, source_url, company_name, contact_name, job_title,
                 phone, country, city, address, website, emails, confidence_score, raw)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            `, [
                job.id,
                job.organizer_id,
                contact.website || job.input,
                contact.company || null,
                contact.name || null,
                contact.title || null,
                contact.phone || null,
                contact.country || null,
                contact.city || null,
                contact.address || null,
                contact.website || null,
                emails,
                contact.confidence || null,
                JSON.stringify(contact)
            ]);
            
            savedCount++;
        }
        
        // Update job
        const summary = {
            ...stats,
            saved_count: savedCount,
            total_emails: totalEmails,
            completed_at: new Date().toISOString()
        };
        
        await client.query(`
            UPDATE mining_jobs 
            SET status = 'completed',
                total_found = $1,
                total_emails_raw = $2,
                stats = $3,
                completed_at = NOW(),
                file_data = NULL
            WHERE id = $4
        `, [savedCount, totalEmails, JSON.stringify(summary), job.id]);
        
        await client.query('COMMIT');
        console.log(`   💾 Saved ${savedCount} contacts to database`);
        
        return { savedCount, totalEmails };
        
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('   ❌ Database save error:', err.message);
        throw err;
        
    } finally {
        client.release();
    }
}

// ============================================
// 13. MAIN ENTRY POINT
// ============================================
async function runFileMining(job) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📂 LIFFY FILE MINER V12.0 (STRUCTURED)`);
    console.log(`Job ID: ${job.id}`);
    console.log(`File: ${job.input}`);
    console.log(`${'='.repeat(60)}`);
    
    const startTime = Date.now();
    
    try {
        // Validate job
        if (!job.file_data) {
            throw new Error('No file data found in job. File may not have been uploaded correctly.');
        }
        
        // Ensure buffer
        const buffer = ensureBuffer(job.file_data);
        
        if (buffer.length === 0) {
            throw new Error('File buffer is empty');
        }
        
        // Process file
        const { contacts, stats } = await processFile(buffer, job.input);
        
        // Results summary
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        
        console.log(`\n   ${'─'.repeat(40)}`);
        console.log(`   📊 MINING SUMMARY`);
        console.log(`   ${'─'.repeat(40)}`);
        console.log(`   File: ${job.input}`);
        console.log(`   Method: ${stats.extraction_method}`);
        console.log(`   Text extracted: ${stats.text_length} chars`);
        console.log(`   Contacts found: ${contacts.length}`);
        console.log(`   Duration: ${duration}s`);
        
        if (contacts.length > 0) {
            console.log(`\n   📧 Sample contacts:`);
            contacts.slice(0, 3).forEach((c, i) => {
                console.log(`      ${i + 1}. ${c.email} | ${c.name || '-'} | ${c.company || '-'} | ${c.phone || '-'}`);
            });
        }
        
        // Save to database
        await saveResultsToDb(job, contacts, stats);
        
        console.log(`\n   ✅ Mining completed successfully!`);
        console.log(`${'='.repeat(60)}\n`);
        
        return {
            status: 'SUCCESS',
            contacts,
            stats
        };
        
    } catch (err) {
        console.error(`\n   ❌ MINING ERROR: ${err.message}`);
        console.error(`   Stack: ${err.stack}`);
        
        // Update job as failed
        try {
            await db.query(`
                UPDATE mining_jobs 
                SET status = 'failed', 
                    error = $1,
                    file_data = NULL
                WHERE id = $2
            `, [err.message, job.id]);
        } catch (dbErr) {
            console.error('   ❌ Could not update job status:', dbErr.message);
        }
        
        throw err;
    }
}

// ============================================
// EXPORTS
// ============================================
module.exports = { 
    runFileMining,
    // Export helpers for testing
    parseStructuredText,
    extractContactsAroundEmails,
    mergeContacts,
    extractTextFromPDF,
    extractTextFromWord,
    processFile
};
