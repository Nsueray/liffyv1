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
// 2a. PDF TABLE EXTRACTION (pdfplumber)
// ============================================
async function tryPdfPlumber(tempPath) {
    try {
        const scriptPath = path.join(__dirname, 'extractors', 'pdfTableExtractor.py');
        console.log("   [0/4] Trying pdfplumber table extraction...");
        const { stdout } = await execPromise(
            `python3 "${scriptPath}" "${tempPath}"`,
            { timeout: 30000, maxBuffer: CONFIG.MAX_BUFFER }
        );
        const parsed = JSON.parse(stdout);
        if (parsed.error) {
            console.log(`   ⚠️ pdfplumber error: ${parsed.error}`);
            return null;
        }
        if (parsed.has_tables && parsed.tables.length > 0) {
            const totalRows = parsed.tables.reduce((sum, t) => sum + t.rows.length, 0);
            console.log(`   ✅ pdfplumber found ${parsed.tables.length} table(s), ${totalRows} data rows`);
            return parsed;
        }
        console.log("   ⚠️ pdfplumber: No tables detected");
        return null;
    } catch (err) {
        console.log(`   ⚠️ pdfplumber failed: ${err.message.slice(0, 100)}`);
        return null;
    }
}

function extractContactsFromTables(tableData) {
    const contacts = [];
    const processedEmails = new Set();

    for (const table of tableData.tables) {
        const headers = table.headers.map(h => (h || '').toLowerCase().trim());

        // Column mapping from headers
        const colMap = {};
        headers.forEach((h, i) => {
            if (/email|e-mail|mail/i.test(h)) colMap.email = i;
            else if (/company|firm|organi[sz]ation|name/i.test(h) && !/email|contact/i.test(h)) colMap.company = i;
            else if (/location|state|address|city/i.test(h)) colMap.location = i;
            else if (/phone|tel|mobile/i.test(h)) colMap.phone = i;
            else if (/service|sector|category/i.test(h)) colMap.services = i;
            else if (/s\/no|no\.|#|serial/i.test(h)) colMap.sno = i;
            else if (/website|url|web/i.test(h)) colMap.website = i;
            else if (/contact.*name|person|representative/i.test(h)) colMap.contact_name = i;
            else if (/title|position|role/i.test(h)) colMap.job_title = i;
        });

        // If no email column detected by header, find by content
        if (colMap.email === undefined) {
            for (let i = 0; i < headers.length; i++) {
                const hasEmail = table.rows.some(row => row[i] && row[i].includes('@'));
                if (hasEmail) { colMap.email = i; break; }
            }
        }

        // If no company column, find first non-email text column
        if (colMap.company === undefined && colMap.email !== undefined) {
            for (let i = 0; i < headers.length; i++) {
                if (i === colMap.email || i === colMap.sno) continue;
                const hasText = table.rows.some(row => row[i] && row[i].length > 3 && !row[i].includes('@'));
                if (hasText) { colMap.company = i; break; }
            }
        }

        // Extract contacts — track current company for multi-row entries
        let currentCompany = '';
        let currentLocation = '';

        for (const row of table.rows) {
            const rowCompany = colMap.company !== undefined ? (row[colMap.company] || '').trim() : '';
            const rowLocation = colMap.location !== undefined ? (row[colMap.location] || '').trim() : '';

            if (rowCompany && rowCompany.length > 1 && !/^\d+$/.test(rowCompany)) {
                currentCompany = rowCompany;
            }
            if (rowLocation) {
                currentLocation = rowLocation;
            }

            // Find emails in email column or anywhere in row
            let emails = [];
            if (colMap.email !== undefined && row[colMap.email]) {
                const cellEmails = row[colMap.email].match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
                if (cellEmails) emails.push(...cellEmails);
            }
            if (emails.length === 0) {
                for (const cell of row) {
                    if (!cell) continue;
                    const found = cell.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
                    if (found) emails.push(...found);
                }
            }

            for (const email of emails) {
                const emailLower = email.toLowerCase();
                if (processedEmails.has(emailLower)) continue;
                if (/^(noreply|no-reply|mailer-daemon|postmaster|hostmaster|abuse|webmaster|test)@/i.test(email)) continue;
                if (PATTERNS.emailBlacklist.some(bl => emailLower.includes(bl))) continue;
                // Skip reversed/garbled emails (from rotated PDF tables)
                const domain = emailLower.split('@')[1] || '';
                const tldParts = domain.split('.');
                const tld = tldParts[tldParts.length - 1] || '';
                const VALID_TLDS = new Set(['com','org','net','gov','edu','io','co','ng','uk','de','fr','us','in','za','gh','ke','biz','info','app','tech','me','tv','cc','ai','dev']);
                if (!VALID_TLDS.has(tld)) continue;

                processedEmails.add(emailLower);

                contacts.push({
                    email: emailLower,
                    company: currentCompany || null,
                    name: colMap.contact_name !== undefined ? (row[colMap.contact_name] || '').trim() || null : null,
                    title: colMap.job_title !== undefined ? (row[colMap.job_title] || '').trim() || null : null,
                    phone: colMap.phone !== undefined ? (row[colMap.phone] || '').trim() || null : null,
                    website: colMap.website !== undefined ? (row[colMap.website] || '').trim() || null : null,
                    city: currentLocation || null,
                    country: null,
                    address: null,
                });
            }
        }
    }

    console.log(`   📊 Table extraction found ${contacts.length} contacts`);
    return contacts;
}

// ============================================
// 2b. TEXT EXTRACTION - PDF
// ============================================
async function extractTextFromPDF(buffer) {
    const tempPath = path.join(os.tmpdir(), `liffy_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`);

    try {
        await fs.promises.writeFile(tempPath, buffer);
        const stats = await fs.promises.stat(tempPath);
        console.log(`   📁 Temp PDF written: ${stats.size} bytes`);

        let text = '';
        let method = 'none';
        let tableContacts = null;

        // METHOD 0: pdfplumber table extraction (structured tables)
        const tableData = await tryPdfPlumber(tempPath);
        if (tableData && tableData.has_tables) {
            const contacts = extractContactsFromTables(tableData);
            if (contacts.length > 0) {
                tableContacts = contacts;
                method = 'pdfplumber-table';
                console.log(`   ✅ pdfplumber-table: ${contacts.length} contacts from structured tables`);
            }
        }

        // METHOD 1: pdftotext (Poppler) - Best for text-based PDFs
        // Always run for text fallback even if tables found
        try {
            console.log("   [1/4] Trying pdftotext...");
            const { stdout, stderr } = await execPromise(
                `pdftotext -layout -enc UTF-8 "${tempPath}" -`,
                { timeout: CONFIG.PDF_TIMEOUT, maxBuffer: CONFIG.MAX_BUFFER }
            );

            const cleanText = stdout.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''); // Remove control chars
            if (cleanText.trim().length >= CONFIG.MIN_TEXT_LENGTH) {
                text = cleanText;
                if (!tableContacts) method = 'pdftotext';
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

        return { text: text || '', method, tableContacts: tableContacts || null };

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
// 5b. COLUMNAR PDF TABLE PARSER
// ============================================
/**
 * Parses pdftotext -layout output that has columnar table structure.
 * Detects numbered entries (S/No) with company, email, location columns.
 * Handles multi-line entries where company/email span multiple rows.
 */
function parseColumnarPdfText(text) {
    // Split on form feeds first to separate pages, then split lines
    const lines = text.replace(/\f/g, '\n\f\n').split(/\r?\n/);
    const contacts = [];
    const processedEmails = new Set();

    // Detect if text looks like a columnar table:
    // - Has numbered entries (1, 2, 3... at line start)
    // - Has emails scattered through the text
    // - Lines have significant whitespace gaps (column separators)
    const numberedLinePattern = /^\s{0,5}\d{1,3}\s{1,4}[A-Z]/;
    const numberedLines = lines.filter(l => numberedLinePattern.test(l));
    const emailLines = lines.filter(l => PATTERNS.email.test(l));

    if (numberedLines.length < 3 || emailLines.length < 3) {
        return []; // Not a columnar table
    }

    console.log(`   📊 Columnar parser: ${numberedLines.length} numbered entries, ${emailLines.length} email lines`);

    // Build entry blocks: each numbered line starts a new entry
    // Collect all lines until the next numbered entry or page break
    const entries = [];
    let currentEntry = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Page break (\f) ends current entry
        if (line.includes('\f')) {
            if (currentEntry) { entries.push(currentEntry); currentEntry = null; }
            continue;
        }

        // Skip header lines (before first numbered entry)
        if (!currentEntry && !numberedLinePattern.test(line)) continue;

        // New numbered entry starts
        if (numberedLinePattern.test(line)) {
            if (currentEntry) entries.push(currentEntry);
            currentEntry = { lines: [line], number: parseInt(line.match(/\d+/)[0], 10) };
        } else if (currentEntry) {
            // Double blank line = possible entry boundary
            if (line.trim() === '') {
                let nextNonBlank = i + 1;
                while (nextNonBlank < lines.length && lines[nextNonBlank].trim() === '') nextNonBlank++;
                if (nextNonBlank < lines.length && (numberedLinePattern.test(lines[nextNonBlank]) || lines[nextNonBlank].includes('\f'))) {
                    entries.push(currentEntry);
                    currentEntry = null;
                } else {
                    currentEntry.lines.push(line);
                }
            } else {
                currentEntry.lines.push(line);
            }
        }
    }
    if (currentEntry) entries.push(currentEntry);

    console.log(`   📊 Columnar parser: ${entries.length} entry blocks detected`);

    // Extract company + emails from each entry block
    for (const entry of entries) {
        const blockText = entry.lines.join('\n');
        const blockEmails = blockText.match(PATTERNS.email) || [];
        if (blockEmails.length === 0) continue;

        // Extract company name from the entry block.
        // Company name appears in the left column (chars ~5-38), on the numbered line
        // and possibly the line directly below (for long company names like "ITS Drilling Services Nigeria\nLimited").
        let companyParts = [];
        let foundCompanyLine = false;
        for (const line of entry.lines) {
            // Numbered line with company name: "   1 Nubian Nigeria Ltd   email@...   Location"
            const numberedMatch = line.match(/^\s{0,5}\d{1,3}\s{1,4}([A-Z][A-Za-z\s&.,()'-]+?)(?:\s{3,}|$)/);
            if (numberedMatch) {
                const candidate = numberedMatch[1].trim();
                if (candidate.length > 2 && !candidate.includes('@') &&
                    !/^\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(candidate) &&
                    !/^(Onshore|Offshore|Water|Hazardous|Tank|Thermal|Waste|Spent|WBM|Inciner|Secondary)/i.test(candidate)) {
                    companyParts.push(candidate);
                    foundCompanyLine = true;
                    continue;
                }
            }
            // Continuation line for company name (indented, no email, no date, appears right after numbered line)
            if (foundCompanyLine && companyParts.length < 3) {
                const contMatch = line.match(/^\s{5,10}([A-Z][A-Za-z\s&.,()'-]+?)(?:\s{3,}|$)/);
                if (contMatch) {
                    const candidate = contMatch[1].trim();
                    if (candidate.length > 2 && candidate.length < 40 && !candidate.includes('@') &&
                        !/^\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(candidate) &&
                        !/^(Onshore|Offshore|Water|Hazardous|Tank|Thermal|Waste|Spent|WBM|Inciner|Secondary)/i.test(candidate)) {
                        companyParts.push(candidate);
                        continue;
                    }
                }
                foundCompanyLine = false; // Stop looking after non-matching line
            }
        }

        const companyName = companyParts.join(' ').replace(/\s+/g, ' ').trim();

        // Extract location from the block
        let location = '';
        const locationMatch = blockText.match(/(?:Rivers|Lagos|Abuja|Delta|Bayelsa|Edo|Imo|Abia|Akwa\s*Ibom|Cross\s*River|Ondo|Ogun|Oyo|Kaduna|Kano|Enugu|Anambra)\s*State/i);
        if (locationMatch) {
            location = locationMatch[0].trim();
        }

        // Create contact for each unique email
        for (const email of blockEmails) {
            const emailLower = email.toLowerCase();
            if (processedEmails.has(emailLower)) continue;
            if (PATTERNS.emailBlacklist.some(bl => emailLower.includes(bl))) continue;
            processedEmails.add(emailLower);

            contacts.push({
                email: emailLower,
                company: companyName || null,
                name: null,
                phone: extractPhoneFromText(blockText),
                country: detectCountry(blockText),
                city: location || null,
                website: extractWebsite(blockText, emailLower),
                title: null,
                address: null,
            });
        }
    }

    console.log(`   📊 Columnar parser found ${contacts.length} contacts`);
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

// Word boundary match helper — prevents "ad" matching inside "lead"
function _wordMatch(text, keyword) {
    const words = text.split(/[\s_\-]+/);
    return words.includes(keyword);
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
            const hasName = row.some(c => _wordMatch(c, 'name') || _wordMatch(c, 'contact'));

            if (hasEmail || hasName) {
                headerRow = rows[i].map(c => String(c).toLowerCase().trim());
                headerIndex = i;
                break;
            }
        }

        // Map columns — source checked before name to prevent "lead source" → name
        const colMap = {};
        if (headerRow) {
            headerRow.forEach((header, idx) => {
                const words = header.split(/[\s_\-]+/);
                if (header.includes('email') || header.includes('e-mail')) colMap.email = idx;
                else if (words.includes('company') || words.includes('organization') || words.includes('firm') || words.includes('firma')) colMap.company = idx;
                else if (words.includes('source') || header.includes('lead source') || words.includes('kaynak') || words.includes('kanal') || words.includes('channel')) colMap.source = idx;
                else if (words.includes('name') || words.includes('contact') || words.includes('isim') || words.includes('ad')) colMap.name = idx;
                else if (words.includes('phone') || words.includes('tel') || words.includes('mobile') || words.includes('telefon')) colMap.phone = idx;
                else if (words.includes('country') || words.includes('ülke')) colMap.country = idx;
                else if (words.includes('city') || words.includes('şehir')) colMap.city = idx;
                else if (words.includes('website') || words.includes('url') || words.includes('web')) colMap.website = idx;
                else if (words.includes('title') || words.includes('position') || words.includes('role')) colMap.title = idx;
                else if (words.includes('address') || words.includes('adres')) colMap.address = idx;
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
                source: colMap.source !== undefined ? String(row[colMap.source] || '').trim() : null,
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
    let pdfTableContacts = null;

    // Extract text based on file type
    if (ext === '.pdf') {
        const result = await extractTextFromPDF(buffer);
        text = result.text;
        method = result.method;
        pdfTableContacts = result.tableContacts;
        
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

    // Method 0: PDF table contacts (pdfplumber structured extraction)
    if (pdfTableContacts && pdfTableContacts.length > 0) {
        console.log(`   📊 Using ${pdfTableContacts.length} contacts from PDF table extraction`);
        // Score table contacts with confidence
        for (const c of pdfTableContacts) {
            c.confidence = calculateConfidence(c);
            c.source_type = 'file_mining';
        }
        contacts = contacts.concat(pdfTableContacts);
    }

    // Method 0b: Columnar PDF table parser (pdftotext -layout output)
    if (ext === '.pdf' && text.length > 0) {
        const columnarContacts = parseColumnarPdfText(text);
        if (columnarContacts.length > 0) {
            for (const c of columnarContacts) {
                c.confidence = calculateConfidence(c);
                c.source_type = 'file_mining';
            }
            contacts = contacts.concat(columnarContacts);
        }
    }

    // Method 1: Excel structured mining
    if (excelData && excelData.sheets && excelData.sheets.length > 0) {
        const excelContacts = mineExcelStructured(excelData.sheets);
        contacts = contacts.concat(excelContacts);
    }

    // Method 2: Structured text parsing (also runs for PDFs to catch anything tables missed)
    if (text.length > 0) {
        const structuredContacts = parseStructuredText(text);
        const emailCentricContacts = extractContactsAroundEmails(text);

        // Merge all contacts (deduplicates by email)
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
