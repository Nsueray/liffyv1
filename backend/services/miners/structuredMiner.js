/**
 * Structured Miner v2.2 - DEBUG VERSION
 */

const { FIELD_LABELS, detectFieldFromLabel } = require('./labelPatterns');

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;

function mine(text) {
    if (!text || typeof text !== 'string') {
        return { contacts: [], stats: { method: 'structured', parsed: 0 } };
    }

    console.log('   [StructuredMiner] Processing ' + text.length + ' chars');
    
    // DEBUG: Show first 500 chars of text
    console.log('   [StructuredMiner] TEXT PREVIEW:');
    console.log('   ---START---');
    console.log(text.substring(0, 500));
    console.log('   ---END---');

    const normalizedText = normalizeText(text);
    const lines = normalizedText.split('\n').map(l => l.trim()).filter(l => l !== undefined);
    
    console.log('   [StructuredMiner] ' + lines.filter(l => l).length + ' lines');
    
    // DEBUG: Show first 10 non-empty lines
    const nonEmptyLines = lines.filter(l => l && l.trim());
    console.log('   [StructuredMiner] First 10 lines:');
    for (let i = 0; i < Math.min(10, nonEmptyLines.length); i++) {
        const line = nonEmptyLines[i];
        const parsed = parseLabelValueLine(line);
        console.log('   Line ' + i + ': "' + line + '" => ' + (parsed ? JSON.stringify(parsed) : 'null'));
    }

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

function parseByBlocks(text) {
    const contacts = [];
    const blocks = text.split(/\n\s*\n/).filter(block => block.trim());
    
    console.log('   [StructuredMiner] Found ' + blocks.length + ' blocks');
    
    // DEBUG: Show first block
    if (blocks.length > 0) {
        console.log('   [StructuredMiner] First block:');
        console.log('   ---BLOCK---');
        console.log(blocks[0].substring(0, 300));
        console.log('   ---END BLOCK---');
    }
    
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
            const { field, value } = parsed;
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
            const { field, value } = parsed;
            
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
    
    // Try colon separator first
    let match = line.match(/^([^:\n]{1,50}?)\s*:\s*(.+)$/);
    
    if (!match) {
        // Try dash separator
        match = line.match(/^([^-\n]{1,50}?)\s*-\s*(.+)$/);
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
    
    let cleaned = value.trim();
    
    cleaned = cleaned
        .replace(/\[([^\]]+)\]\{[^}]*\}/g, '$1')
        .replace(/\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
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
    normalizeText,
    parseByBlocks,
    parseSequential,
    parseBlock,
    parseLabelValueLine,
    cleanFieldValue,
};
