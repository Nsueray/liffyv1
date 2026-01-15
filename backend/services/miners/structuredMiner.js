/**
 * Structured Miner v2.5
 * Fixed: Multiple contacts per block support
 */

const { FIELD_LABELS, detectFieldFromLabel } = require('./labelPatterns');

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;

function mine(text) {
    if (!text || typeof text !== 'string') {
        return { contacts: [], stats: { method: 'structured', parsed: 0 } };
    }

    console.log('   [StructuredMiner] Processing ' + text.length + ' chars');

    const cleanedText = cleanText(text);
    const fixedText = fixBrokenLabels(cleanedText);
    const normalizedText = normalizeText(fixedText);
    const lines = normalizedText.split('\n').map(l => l.trim()).filter(l => l !== undefined);
    
    console.log('   [StructuredMiner] ' + lines.filter(l => l).length + ' lines');

    // Use sequential parsing - it handles multiple contacts better
    let contacts = parseSequential(lines);
    
    console.log('   [StructuredMiner] Found ' + contacts.length + ' contacts');
    
    // Debug
    const withName = contacts.filter(c => c.name);
    console.log('   [StructuredMiner] With name: ' + withName.length + ', Without name: ' + (contacts.length - withName.length));

    return {
        contacts,
        stats: {
            method: 'structured',
            lines: lines.length,
            contacts: contacts.length
        }
    };
}

function cleanText(text) {
    let cleaned = text;
    cleaned = cleaned.replace(/[\u200B-\u200D\uFEFF\u200E\u200F]/g, '');
    cleaned = cleaned.replace(/\\$/gm, '');
    cleaned = cleaned.replace(/\\\n/g, '\n');
    cleaned = cleaned.replace(/\\/g, '');
    cleaned = cleaned.replace(/\[([^\]]+)\]\{[^}]*\}/g, '$1');
    cleaned = cleaned.replace(/\[[^\]]*\]\([^)]*\)/g, '');
    return cleaned;
}

function fixBrokenLabels(text) {
    let fixed = text;
    fixed = fixed.replace(/E\s*\n\s*ma\s*\n\s*il\s*:/gi, 'Email:');
    fixed = fixed.replace(/E\s*-?\s*ma\s*-?\s*il\s*:/gi, 'Email:');
    fixed = fixed.replace(/Em\s*\n\s*ail\s*:/gi, 'Email:');
    fixed = fixed.replace(/Ema\s*\n\s*il\s*:/gi, 'Email:');
    fixed = fixed.replace(/Com\s*\n\s*pany\s*:/gi, 'Company:');
    fixed = fixed.replace(/Comp\s*\n\s*any\s*:/gi, 'Company:');
    fixed = fixed.replace(/Ph\s*\n\s*one\s*:/gi, 'Phone:');
    fixed = fixed.replace(/Pho\s*\n\s*ne\s*:/gi, 'Phone:');
    fixed = fixed.replace(/Coun\s*\n\s*try\s*:/gi, 'Country:');
    fixed = fixed.replace(/Count\s*\n\s*ry\s*:/gi, 'Country:');
    fixed = fixed.replace(/Na\s*\n\s*me\s*:/gi, 'Name:');
    return fixed;
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

/**
 * Sequential parsing - handles multiple contacts in same block
 * New contact starts when we see "Company:" and already have data
 */
function parseSequential(lines) {
    const contacts = [];
    let currentContact = {};
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        if (!line || !line.trim()) {
            continue; // Don't save on blank line - save on Company: trigger
        }
        
        const parsed = parseLabelValueLine(line);
        
        if (parsed) {
            let { field, value } = parsed;
            
            // Force email field if value looks like email
            if (value && value.match(EMAIL_REGEX) && field !== 'email') {
                field = 'email';
            }
            
            // NEW CONTACT TRIGGER: We see "Company:" and already have company OR email
            if (field === 'company' && (currentContact.company || currentContact.email)) {
                // Save current contact if it has email
                if (currentContact.email) {
                    contacts.push({ ...currentContact });
                }
                currentContact = {};
            }
            
            // Store the value
            if (value && value.trim()) {
                currentContact[field] = cleanFieldValue(field, value);
            }
        }
    }
    
    // Don't forget last contact
    if (currentContact.email) {
        contacts.push({ ...currentContact });
    }
    
    return contacts;
}

function parseLabelValueLine(line) {
    if (!line) return null;
    
    const cleanLine = line.replace(/[\u200B-\u200D\uFEFF\u200E\u200F]/g, '').trim();
    if (!cleanLine) return null;
    
    let match = cleanLine.match(/^([^:\n]{1,50}?)\s*:\s*(.+)$/);
    if (!match) {
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
    
    let cleaned = value.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\\]/g, '').trim();
    
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
    cleanText,
    fixBrokenLabels,
    normalizeText,
    parseSequential,
    parseLabelValueLine,
    cleanFieldValue,
};
