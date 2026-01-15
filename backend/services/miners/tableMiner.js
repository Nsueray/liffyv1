/**
 * Table Miner
 * Extracts contacts from tabular data (Excel, CSV)
 * Uses detected headers to map columns to fields
 */

const { detectFieldFromLabel } = require('./labelPatterns');

// Email regex
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;

/**
 * Main mining function
 * @param {Object} excelData - Data from excelExtractor
 * @returns {{contacts: Array, stats: Object}}
 */
function mine(excelData) {
    if (!excelData || !excelData.sheets || excelData.sheets.length === 0) {
        return { contacts: [], stats: { method: 'table', sheets: 0 } };
    }

    console.log(`   [TableMiner] Processing ${excelData.sheets.length} sheets`);

    const allContacts = [];
    
    for (const sheet of excelData.sheets) {
        const contacts = mineSheet(sheet);
        allContacts.push(...contacts);
    }
    
    console.log(`   [TableMiner] Found ${allContacts.length} contacts`);

    return {
        contacts: allContacts,
        stats: {
            method: 'table',
            sheets: excelData.sheets.length,
            contacts: allContacts.length
        }
    };
}

/**
 * Mine a single sheet
 */
function mineSheet(sheet) {
    const contacts = [];
    
    if (!sheet.rows || sheet.rows.length === 0) {
        return contacts;
    }

    // If headers were detected, use column mapping
    if (sheet.headers && sheet.headers.columnMap) {
        return mineWithHeaders(sheet);
    }
    
    // Otherwise, try to find emails in any column
    return mineWithoutHeaders(sheet);
}

/**
 * Mine sheet with known headers
 */
function mineWithHeaders(sheet) {
    const contacts = [];
    const { columnMap } = sheet.headers;
    
    for (const row of sheet.rows) {
        if (!Array.isArray(row)) continue;
        
        const contact = {};
        let hasData = false;
        
        // Extract each mapped field
        for (const [field, colIndex] of Object.entries(columnMap)) {
            const cellValue = row[colIndex];
            
            if (cellValue !== undefined && cellValue !== null) {
                const value = String(cellValue).trim();
                
                if (value) {
                    contact[field] = cleanCellValue(field, value);
                    hasData = true;
                }
            }
        }
        
        // Only include if we have email
        if (contact.email && isValidEmail(contact.email)) {
            contacts.push(contact);
        }
    }
    
    return contacts;
}

/**
 * Mine sheet without headers - search for emails
 */
function mineWithoutHeaders(sheet) {
    const contacts = [];
    const rows = sheet.rawRows || sheet.rows;
    
    for (const row of rows) {
        if (!Array.isArray(row)) continue;
        
        // Find email in row
        let email = null;
        let emailColIndex = -1;
        
        for (let i = 0; i < row.length; i++) {
            const cell = String(row[i] || '');
            const emailMatch = cell.match(EMAIL_REGEX);
            
            if (emailMatch) {
                email = emailMatch[0].toLowerCase();
                emailColIndex = i;
                break;
            }
        }
        
        if (!email || !isValidEmail(email)) continue;
        
        // Build contact from row
        const contact = { email };
        
        // Try to guess other fields from position
        for (let i = 0; i < row.length; i++) {
            if (i === emailColIndex) continue;
            
            const value = String(row[i] || '').trim();
            if (!value) continue;
            
            // Try to detect field type from value
            const detectedField = detectFieldFromValue(value);
            
            if (detectedField && !contact[detectedField]) {
                contact[detectedField] = cleanCellValue(detectedField, value);
            }
        }
        
        contacts.push(contact);
    }
    
    return contacts;
}

/**
 * Clean cell value based on field type
 */
function cleanCellValue(field, value) {
    if (!value) return '';
    
    let cleaned = String(value).trim();
    
    // Remove common Excel artifacts
    cleaned = cleaned
        .replace(/^['"]|['"]$/g, '')  // Quotes
        .replace(/\r?\n/g, ' ')        // Newlines
        .trim();
    
    switch (field) {
        case 'email':
            const emailMatch = cleaned.match(EMAIL_REGEX);
            if (emailMatch) {
                cleaned = emailMatch[0].toLowerCase();
            }
            break;
            
        case 'phone':
            // Keep as-is
            break;
            
        case 'website':
            if (cleaned && !cleaned.startsWith('http') && cleaned.includes('.')) {
                cleaned = 'https://' + (cleaned.startsWith('www.') ? '' : 'www.') + cleaned;
            }
            break;
            
        case 'name':
        case 'company':
            // Title case if all caps/lower
            if (cleaned === cleaned.toUpperCase() || cleaned === cleaned.toLowerCase()) {
                cleaned = cleaned.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
            }
            break;
    }
    
    return cleaned;
}

/**
 * Try to detect field type from value content
 */
function detectFieldFromValue(value) {
    if (!value) return null;
    
    const lower = value.toLowerCase();
    
    // Phone patterns
    if (/^[\d\s\-\+\(\)]{8,20}$/.test(value)) {
        return 'phone';
    }
    
    // URL patterns
    if (/^(https?:\/\/|www\.)/i.test(value) || /\.(com|org|net|io|app)$/i.test(value)) {
        return 'website';
    }
    
    // Country detection (common countries)
    const countries = ['turkey', 'germany', 'france', 'usa', 'uk', 'china', 'india', 'spain', 'italy'];
    if (countries.some(c => lower === c || lower.includes(c))) {
        return 'country';
    }
    
    // If it looks like a person name (2-3 words, no special chars)
    if (/^[A-Za-z\u00C0-\u024F\s]{2,50}$/.test(value)) {
        const words = value.trim().split(/\s+/);
        if (words.length >= 2 && words.length <= 4) {
            return 'name';
        }
    }
    
    // If it contains company indicators
    if (/\b(ltd|inc|corp|llc|gmbh|ag|co\.|company|limited)\b/i.test(value)) {
        return 'company';
    }
    
    return null;
}

/**
 * Validate email format
 */
function isValidEmail(email) {
    if (!email) return false;
    
    // Basic validation
    if (!/@/.test(email)) return false;
    if (email.length < 5) return false;
    
    // Blacklist
    const blacklist = ['.png', '.jpg', '.gif', 'example.com', 'test.com', 'noreply'];
    if (blacklist.some(b => email.toLowerCase().includes(b))) {
        return false;
    }
    
    return EMAIL_REGEX.test(email);
}

module.exports = {
    mine,
    mineSheet,
    mineWithHeaders,
    mineWithoutHeaders,
    cleanCellValue,
    detectFieldFromValue,
    isValidEmail,
};
