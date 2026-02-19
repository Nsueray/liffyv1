/**
 * Excel/CSV Text Extractor
 * Extracts data from Excel (.xlsx, .xls) and CSV/TSV files
 */

const path = require('path');

// Lazy load xlsx
let xlsx;
try { xlsx = require('xlsx'); } catch(e) {}

/**
 * Main extraction function
 * @param {Buffer} buffer - File buffer
 * @param {string} filename - Original filename
 * @returns {Promise<{sheets: Array, text: string, method: string, success: boolean}>}
 */
async function extractData(buffer, filename = '') {
    const ext = path.extname(filename).toLowerCase();
    console.log(`   📊 Excel Extractor: ${buffer.length} bytes, type: ${ext || 'unknown'}`);

    const result = {
        sheets: [],       // Structured data (array of {name, headers, rows})
        text: '',         // Flat text representation
        method: 'none',
        success: false,
        attempts: []
    };

    // Route to appropriate extractor
    if (ext === '.csv' || ext === '.tsv') {
        return extractFromCSV(buffer, ext === '.tsv' ? '\t' : ',');
    }

    // Excel files
    try {
        if (!xlsx) throw new Error('xlsx library not available');

        console.log(`   [Excel] Parsing with xlsx...`);
        const workbook = xlsx.read(buffer, { type: 'buffer' });
        
        let allText = '';
        
        for (const sheetName of workbook.SheetNames) {
            const sheet = workbook.Sheets[sheetName];
            const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
            
            if (rows.length === 0) continue;
            
            // Try to detect headers
            const { headers, dataStartIndex } = detectHeaders(rows);
            
            const sheetData = {
                name: sheetName,
                headers: headers,
                rows: rows.slice(dataStartIndex),
                rawRows: rows
            };
            
            result.sheets.push(sheetData);
            
            // Build text representation
            for (const row of rows) {
                const rowText = row.map(cell => String(cell).trim()).filter(Boolean).join(' | ');
                if (rowText) allText += rowText + '\n';
            }
        }
        
        result.text = allText.trim();
        result.method = 'xlsx';
        result.success = result.sheets.length > 0;
        
        console.log(`   ✅ xlsx: ${result.sheets.length} sheets, ${result.text.length} chars`);
        
    } catch (err) {
        console.log(`   ⚠️ xlsx failed: ${err.message.slice(0, 80)}`);
        result.attempts.push({
            method: 'xlsx',
            error: err.message.slice(0, 100),
            success: false
        });
    }

    return result;
}

/**
 * Extract from CSV/TSV
 */
function extractFromCSV(buffer, delimiter = ',') {
    const result = {
        sheets: [],
        text: '',
        method: 'csv',
        success: false,
        attempts: []
    };

    try {
        const text = buffer.toString('utf8');
        const lines = text.split(/\r?\n/).filter(line => line.trim());
        
        if (lines.length === 0) {
            throw new Error('Empty file');
        }

        const rows = lines.map(line => parseCSVLine(line, delimiter));
        const { headers, dataStartIndex } = detectHeaders(rows);
        
        result.sheets.push({
            name: 'Sheet1',
            headers: headers,
            rows: rows.slice(dataStartIndex),
            rawRows: rows
        });
        
        result.text = text;
        result.success = true;
        
        console.log(`   ✅ CSV: ${rows.length} rows, ${text.length} chars`);
        
    } catch (err) {
        console.log(`   ⚠️ CSV failed: ${err.message}`);
        result.attempts.push({
            method: 'csv',
            error: err.message,
            success: false
        });
    }

    return result;
}

/**
 * Parse a single CSV line (handles quotes)
 */
function parseCSVLine(line, delimiter = ',') {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === delimiter && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    
    result.push(current.trim());
    return result;
}

/**
 * Check if a cell text matches a keyword using word-boundary logic.
 * Multi-word keywords (containing space/underscore/hyphen) use substring match.
 * Single-word keywords require exact word match to prevent
 * false positives like "ad" matching inside "lead".
 */
function cellMatchesKeyword(cell, kw) {
    if (kw.includes(' ') || kw.includes('_') || kw.includes('-')) {
        return cell.includes(kw);
    }
    const cellWords = cell.split(/[\s_\-]+/);
    return cellWords.includes(kw);
}

/**
 * Detect header row and column mapping
 */
function detectHeaders(rows) {
    if (rows.length === 0) {
        return { headers: null, dataStartIndex: 0 };
    }

    // Common header keywords (multi-language)
    // Order matters: source BEFORE name to prevent "lead source" matching "name" via "ad" substring
    const headerKeywords = {
        email: ['email', 'e-mail', 'mail', 'e-posta', 'eposta', 'correo', 'courriel', 'البريد'],
        company: ['company', 'organization', 'organisation', 'firm', 'firma', 'şirket', 'kuruluş', 'société', 'entreprise', 'empresa', 'unternehmen', 'azienda', 'شركة', '公司'],
        source: ['source', 'lead source', 'lead_source', 'kaynak', 'kanal', 'channel', 'origin', 'referral source', 'acquisition'],
        name: ['name', 'contact', 'person', 'isim', 'ad', 'kişi', 'nom', 'prénom', 'nombre', 'nome', 'اسم', '姓名', 'full name', 'fullname', 'contact name'],
        phone: ['phone', 'tel', 'telephone', 'mobile', 'cell', 'gsm', 'telefon', 'cep', 'téléphone', 'teléfono', 'telefono', 'هاتف', '电话'],
        country: ['country', 'nation', 'ülke', 'pays', 'país', 'land', 'paese', 'بلد', '国家'],
        city: ['city', 'şehir', 'il', 'ville', 'ciudad', 'stadt', 'città', 'مدينة', '城市'],
        address: ['address', 'adres', 'adresse', 'dirección', 'indirizzo', 'عنوان', '地址'],
        website: ['website', 'web', 'url', 'site', 'sitio', 'موقع', '网站'],
        title: ['title', 'position', 'role', 'job', 'pozisyon', 'ünvan', 'görev', 'titre', 'poste', 'título', 'cargo', 'وظيفة', '职位'],
    };

    // Check first 5 rows for potential headers
    for (let i = 0; i < Math.min(5, rows.length); i++) {
        const row = rows[i];
        if (!Array.isArray(row)) continue;

        const rowLower = row.map(cell => String(cell).toLowerCase().trim());
        let matchCount = 0;
        const columnMap = {};

        rowLower.forEach((cell, colIndex) => {
            for (const [field, keywords] of Object.entries(headerKeywords)) {
                if (keywords.some(kw => cellMatchesKeyword(cell, kw))) {
                    if (!columnMap[field]) {
                        columnMap[field] = colIndex;
                        matchCount++;
                    }
                    break;
                }
            }
        });

        // If we found at least email or 2+ other fields, this is likely the header
        if (columnMap.email !== undefined || matchCount >= 2) {
            return {
                headers: {
                    rowIndex: i,
                    columnMap: columnMap,
                    rawHeaders: row
                },
                dataStartIndex: i + 1
            };
        }
    }

    // No header detected
    return { headers: null, dataStartIndex: 0 };
}

/**
 * Extract contacts from structured Excel data
 */
function extractContactsFromSheet(sheet) {
    const contacts = [];
    
    if (!sheet.headers || !sheet.headers.columnMap) {
        return contacts;
    }
    
    const { columnMap } = sheet.headers;
    
    for (const row of sheet.rows) {
        if (!Array.isArray(row)) continue;
        
        const contact = {};
        
        for (const [field, colIndex] of Object.entries(columnMap)) {
            const value = row[colIndex];
            if (value !== undefined && value !== null && String(value).trim()) {
                contact[field] = String(value).trim();
            }
        }
        
        // Only include if we have at least an email
        if (contact.email) {
            contacts.push(contact);
        }
    }
    
    return contacts;
}

module.exports = {
    extractData,
    extractFromCSV,
    detectHeaders,
    extractContactsFromSheet,
    parseCSVLine,
};
