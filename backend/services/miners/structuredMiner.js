/**
 * Structured Miner v2.1
 * Extracts contacts from label-based structured text
 * 
 * Handles formats like:
 *   Company: Elan Expo
 *   Name: Suer AY
 *   Email: suer@elanexpo.net
 *   Phone: +905332095377
 *   Country: Turkey
 * 
 * Fixed: Block detection now uses blank lines + email as block end marker
 * Supports 10+ languages
 */

const { FIELD_LABELS, detectFieldFromLabel } = require('./labelPatterns');

// Email regex for validation
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;

/**
 * Main mining function
 * @param {string} text - Extracted text from document
 * @returns {{contacts: Array, stats: Object}}
 */
function mine(text) {
    if (!text || typeof text !== 'string') {
        return { contacts: [], stats: { method: 'structured', parsed: 0 } };
    }

    console.log('   [StructuredMiner] Processing ' + text.length + ' chars');

    // Normalize text first
    const normalizedText = normalizeText(text);
    
    // Split into lines
    const lines = normalizedText.split('\n').map(l => l.trim()).filter(l => l !== undefined);
    
    console.log('   [StructuredMiner] ' + lines.filter(l => l).length + ' lines');

    // Try block-based parsing first (separated by blank lines)
    let contacts = parseByBlocks(normalizedText);
    
    console.log('   [StructuredMiner] parseByBlocks found: ' + contacts.length);
    
    // If block parsing didn't work well, try sequential parsing
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
 * Parse by splitting text into blocks (separated by blank lines)
 * This works well for repeated structured entries
 */
function parseByBlocks(text) {
    const contacts = [];
    
    // Split by double newline or multiple newlines
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

/**
 * Parse a single block of text for contact info
 */
function parseBlock(block) {
    const contact = {};
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    
    for (const line of lines) {
        const parsed = parseLabelValueLine(line);
        if (parsed && parsed.value) {
            const { field, value } = parsed;
            // Don't overwrite if already set (take first value)
            if (!contact[field]) {
                contact[field] = cleanFieldValue(field, value);
            }
        }
    }
    
    return Object.keys(contact).length > 0 ? contact : null;
}

/**
 * Sequential parsing - accumulate fields until we have a complete contact
 * A contact is "complete" when we hit an email, then we save on next company/name
 */
function parseSequential(lines) {
    const contacts = [];
    let currentContact = {};
    let hasSeenEmail = false;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Skip empty lines but use them as potential block separators
        if (!line || !line.trim()) {
            // If we have a complete contact (with email), save it
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
            
            // If we see a new "Company:" and already have a complete contact, save it
            if (field === 'company' && hasSeenEmail && currentContact.email) {
                contacts.push({ ...currentContact });
                currentContact = {};
                hasSeenEmail = false;
            }
            
            // Store the value
            if (value && value.trim()) {
                currentContact[field] = cleanFieldValue(field, value);
                
                // Mark that we've seen an email
                if (field === 'email') {
                    hasSeenEmail = true;
                }
            }
        }
    }
    
    // Don't forget the last contact
    if (currentContact.email) {
        contacts.push({ ...currentContact });
    }
    
    return contacts;
}

/**
 * Normalize text - ensure labels are on separate lines
 */
function normalizeText(text) {
    let normalized = text;
    
    // Build pattern that matches all labels
    const allLabels = Object.values(FIELD_LABELS).flat();
    
    // Create a pattern that finds labels not at start of line
    for (const label of allLabels) {
        // Case-insensitive replacement
        const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp('(?<!^|\\n)(' + escapedLabel + ')\\s*[:\\-]', 'gim');
        normalized = normalized.replace(pattern, '\n$1:');
    }
    
    // Normalize line endings
    normalized = normalized
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\n{3,}/g, '\n\n');
    
    return normalized;
}

/**
 * Parse a line as "Label: Value"
 */
function parseLabelValueLine(line) {
    if (!line) return null;
    
    // Pattern: LabelText : Value (or LabelText - Value)
    // Allow more characters in label (up to first : or -)
    const match = line.match(/^([^:\n]{1,50}?)\s*[:\-]\s*(.*)$/);
    
    if (!match) return null;
    
    const [, labelPart, valuePart] = match;
    
    // Skip if label part is too short or looks like a value
    if (!labelPart || labelPart.length < 2) return null;
    
    // Detect field from label
    const field = detectFieldFromLabel(labelPart);
    
    if (!field) return null;
    
    return {
        field,
        label: labelPart.trim(),
        value: valuePart.trim()
    };
}

/**
 * Clean field value based on field type
 */
function cleanFieldValue(field, value) {
    if (!value) return '';
    
    let cleaned = value.trim();
    
    // Remove common artifacts
    cleaned = cleaned
        .replace(/\[([^\]]+)\]\{[^}]*\}/g, '$1')  // Markdown links
        .replace(/\[[^\]]*\]\([^)]*\)/g, '')       // Inline links
        .replace(/<[^>]+>/g, '')                    // HTML tags
        .replace(/[\u200B-\u200D\uFEFF]/g, '')     // Zero-width chars
        .trim();
    
    // Field-specific cleaning
    switch (field) {
        case 'email':
            // Extract just the email if there's extra text
            const emailMatch = cleaned.match(EMAIL_REGEX);
            if (emailMatch) {
                cleaned = emailMatch[0].toLowerCase();
            }
            // Remove trailing punctuation
            cleaned = cleaned.replace(/[,;:.]+$/, '');
            break;
            
        case 'phone':
            // Keep phone as-is but trim
            cleaned = cleaned.replace(/[,;:.]+$/, '');
            break;
            
        case 'website':
            // Ensure URL format
            if (cleaned && !cleaned.startsWith('http')) {
                if (cleaned.startsWith('www.')) {
                    cleaned = 'https://' + cleaned;
                }
            }
            break;
            
        case 'name':
        case 'company':
        case 'title':
            // Capitalize properly if all caps or all lower
            if (cleaned === cleaned.toUpperCase() || cleaned === cleaned.toLowerCase()) {
                cleaned = toTitleCase(cleaned);
            }
            break;
    }
    
    return cleaned;
}

/**
 * Convert to title case
 */
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
