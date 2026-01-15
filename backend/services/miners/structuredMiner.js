/**
 * Structured Miner
 * Extracts contacts from label-based structured text
 * 
 * Handles formats like:
 *   Company: Elan Expo
 *   Name: Suer AY
 *   Email: suer@elanexpo.net
 *   Phone: +905332095377
 *   Country: Turkey
 * 
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

    console.log(`   [StructuredMiner] Processing ${text.length} chars`);

    // Normalize text first
    const normalizedText = normalizeText(text);
    
    // Split into lines
    const lines = normalizedText.split('\n').map(l => l.trim()).filter(Boolean);
    
    console.log(`   [StructuredMiner] ${lines.length} lines`);

    // Parse contacts
    const contacts = parseStructuredContacts(lines);
    
    console.log(`   [StructuredMiner] Found ${contacts.length} contacts`);

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
        const pattern = new RegExp(`(?<!^|\\n)(${escapedLabel})\\s*[:\\-]`, 'gim');
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
 * Parse contacts from lines
 */
function parseStructuredContacts(lines) {
    const contacts = [];
    let currentContact = {};
    let lastField = null;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Try to parse as "Label: Value"
        const parsed = parseLabelValueLine(line);
        
        if (parsed) {
            const { field, value } = parsed;
            
            // If we hit a new contact block (company or name at start)
            if ((field === 'company' || field === 'name') && hasMinimumData(currentContact)) {
                // Save current contact if it has email
                if (currentContact.email) {
                    contacts.push({ ...currentContact });
                }
                currentContact = {};
            }
            
            // Store the value
            if (value && value.trim()) {
                // Clean up the value
                currentContact[field] = cleanFieldValue(field, value);
            }
            
            lastField = field;
        } else {
            // Not a label line - could be a continuation or separator
            // If it's a blank line, might be end of contact block
            if (!line.trim() && hasMinimumData(currentContact)) {
                if (currentContact.email) {
                    contacts.push({ ...currentContact });
                }
                currentContact = {};
                lastField = null;
            }
        }
    }
    
    // Don't forget last contact
    if (currentContact.email) {
        contacts.push({ ...currentContact });
    }
    
    return contacts;
}

/**
 * Parse a line as "Label: Value"
 */
function parseLabelValueLine(line) {
    if (!line) return null;
    
    // Pattern: LabelText : Value (or LabelText - Value)
    const match = line.match(/^([^:\-\n]{1,50})\s*[:\-]\s*(.*)$/);
    
    if (!match) return null;
    
    const [, labelPart, valuePart] = match;
    
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
 * Check if contact has minimum data
 */
function hasMinimumData(contact) {
    return contact && (
        contact.email ||
        contact.company ||
        contact.name ||
        contact.phone
    );
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
    parseStructuredContacts,
    parseLabelValueLine,
    cleanFieldValue,
};
