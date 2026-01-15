/**
 * Structured Miner v2.3
 * Fixed: Email detection by value format (not just label)
 */

const { FIELD_LABELS, detectFieldFromLabel } = require('./labelPatterns');

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;

function mine(text) {
    if (!text || typeof text !== 'string') {
        return { contacts: [], stats: { method: 'structured', parsed: 0 } };
    }

    console.log('   [StructuredMiner] Processing ' + text.length + ' chars');

    // First, try to fix broken "Email" labels
    const fixedText = fixBrokenLabels(text);
    const normalizedText = normalizeText(fixedText);
    const lines = normalizedText.split('\n').map(l => l.trim()).filter(l => l !== undefined);
    
    console.log('   [StructuredMiner] ' + lines.filter(l => l).length + ' lines');

    let contacts = parseByBlocks(normalizedText);
    
    console.log('   [StructuredMiner] parseByBlocks found: ' + contacts.length);
    
    if (contacts.length === 0) {
        contacts = parseSequential(lines);
        console.log('   [StructuredMiner] parseSequential found: ' + contacts.length);
    }
    
    console.log('   [StructuredMiner] Found ' + contacts.length + ' contacts');

    return {
        contacts,
        stats: {
            method: 'structured',
            lines: lines.length,
            contacts: contacts.length
        }
    };
}

/**
 * Fix broken labels like "E\nma\nil:" -> "Email:"
 */
function fixBrokenLabels(text) {
    let fixed = text;
    
    // Fix broken "Email" - various patterns
    fixed = fixed.replace(/E\s*\n\s*ma\s*\n\s*il\s*:/gi, 'Email:');
    fixed = fixed.replace(/E\s*-?\s*ma\s*-?\s*il\s*:/gi, 'Email:');
    fixed = fixed.replace(/Em\s*\n\s*ail\s*:/gi, 'Email:');
    fixed = fixed.replace(/Ema\s*\n\s*il\s*:/gi, 'Email:');
    
    // Fix broken "Company"
    fixed = fixed.replace(/Com\s*\n\s*pany\s*:/gi, 'Company:');
    fixed = fixed.replace(/Comp\s*\n\s*any\s*:/gi, 'Company:');
    
    // Fix broken "Phone"
    fixed = fixed.replace(/Ph\s*\n\s*one\s*:/gi, 'Phone:');
    fixed = fixed.replace(/Pho\s*\n\s*ne\s*:/gi, 'Phone:');
    
    // Fix broken "Country"
    fixed = fixed.replace(/Coun\s*\n\s*try\s*:/gi, 'Country:');
    fixed = fixed.replace(/Count\s*\n\s*ry\s*:/gi, 'Country:');
    
    // Fix broken "Name"
    fixed = fixed.replace(/Na\s*\n\s*me\s*:/gi, 'Name:');
    
    return fixed;
}

function parseByBlocks(text) {
    const contacts = [];
    const blocks = text.split(/\n\s*\n/).filter(block => block.trim());
    
    console.log('   [StructuredMiner] Found ' + blocks.length + ' blocks');
    
    for (const block of blocks) {
        const contact = parseBlock(block);
        if (contact && contact.email) {
            contacts.push(contact);
        }
    }
    
    return contacts;
}

function parseBlock(block) {
    const contact = {};
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    
    for (const line of lines) {
        const parsed = parseLabelValueLine(line);
        if (parsed && parsed.value) {
            let { field, value } = parsed;
            
            // CRITICAL FIX: If value looks like an email, force field to 'email'
            if (value.match(EMAIL_REGEX) && field !== 'email') {
                console.log('   [StructuredMiner] Forcing email field for: ' + value);
                field = 'email';
            }
            
            if (!contact[field]) {
                contact[field] = cleanFieldValue(field, value);
            }
        }
    }
    
    return Object.keys(contact).length > 0 ? contact : null;
}

function parseSequential(lines) {
    const contacts = [];
    let currentContact = {};
    let hasSeenEmail = false;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        if (!line || !line.trim()) {
            if (hasSeenEmail && currentContact.email) {
                contacts.push({ ...currentContact });
                currentContact = {};
                hasSeenEmail = false;
            }
            continue;
        }
        
        const parsed = parseLabelValueLine(line);
        
        if (parsed) {
            let { field, value } = parsed;
            
            // CRITICAL FIX: If value looks like an email, force field to 'email'
            if (value && value.match(EMAIL_REGEX) && field !== 'email') {
                field = 'email';
            }
            
            if (field === 'company' && hasSeenEmail && currentContact.email) {
                contacts.push({ ...currentContact });
                currentContact = {};
                hasSeenEmail = false;
            }
            
            if (value && value.trim()) {
                currentContact[field] = cleanFieldValue(field, value);
                if (field === 'email') {
                    hasSeenEmail = true;
                }
            }
        }
    }
    
    if (currentContact.email) {
        contacts.push({ ...currentContact });
    }
    
    return contacts;
}

function normalizeText(text) {
    let normalized = text;
    
    const allLabels = Object.values(FIELD_LABELS).flat();
    
    for (const label of allLabels) {
        const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp('(?<!^|\\n)(' + escapedLabel + ')\\s*[:\\-]', 'gim');
        normalized = normalized.replace(pattern, '\n$1:');
    }
    
    normalized = normalized
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\n{3,}/g, '\n\n');
    
    return normalized;
}

function parseLabelValueLine(line) {
    if (!line) return null;
    
    // Clean zero-width characters first
    const cleanLine = line.replace(/[\u200B-\u200D\uFEFF\u200E\u200F]/g, '').trim();
    
    if (!cleanLine) return null;
    
    // Try colon separator first
    let match = cleanLine.match(/^([^:\n]{1,50}?)\s*:\s*(.+)$/);
    
    if (!match) {
        // Try dash separator
        match = cleanLine.match(/^([^-\n]{1,50}?)\s*-\s*(.+)$/);
    }
    
    if (!match) return null;
    
    const [, labelPart, valuePart] = match;
    
    if (!labelPart || labelPart.length < 2) return null;
    
    const field = detectFieldFromLabel(labelPart);
    
    if (!field) return null;
    
    return {
        field,
        label: labelPart.trim(),
        value: valuePart.trim()
    };
}

function cleanFieldValue(field, value) {
    if (!value) return '';
    
    // Remove zero-width characters
    let cleaned = value.replace(/[\u200B-\u200D\uFEFF\u200E\u200F]/g, '').trim();
    
    cleaned = cleaned
        .replace(/\[([^\]]+)\]\{[^}]*\}/g, '$1')
        .replace(/\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/<[^>]+>/g, '')
        .trim();
    
    switch (field) {
        case 'email':
            const emailMatch = cleaned.match(EMAIL_REGEX);
            if (emailMatch) {
                cleaned = emailMatch[0].toLowerCase();
            }
            cleaned = cleaned.replace(/[,;:.]+$/, '');
            break;
            
        case 'phone':
            cleaned = cleaned.replace(/[,;:.]+$/, '');
            break;
            
        case 'website':
            if (cleaned && !cleaned.startsWith('http')) {
                if (cleaned.startsWith('www.')) {
                    cleaned = 'https://' + cleaned;
                }
            }
            break;
            
        case 'name':
        case 'company':
        case 'title':
            if (cleaned === cleaned.toUpperCase() || cleaned === cleaned.toLowerCase()) {
                cleaned = toTitleCase(cleaned);
            }
            break;
    }
    
    return cleaned;
}

function toTitleCase(str) {
    return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

module.exports = {
    mine,
    fixBrokenLabels,
    normalizeText,
    parseByBlocks,
    parseSequential,
    parseBlock,
    parseLabelValueLine,
    cleanFieldValue,
};
