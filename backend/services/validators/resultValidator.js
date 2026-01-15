/**
 * Result Validator
 * Cleans and validates contact data
 * Fixes common issues with extracted data
 */

// Email regex
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// Phone regex for validation
const PHONE_REGEX = /^[\d\s\+\-\(\)\.]{8,20}$/;

// Blacklists
const EMAIL_BLACKLIST = [
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.pdf', '.doc',
    'example.com', 'test.com', 'sample.com',
    'wix.com', 'sentry.io', 'wordpress.com',
    'noreply', 'no-reply', 'donotreply', 'mailer-daemon',
];

const WEBSITE_BLACKLIST = [
    'facebook.com', 'twitter.com', 'linkedin.com', 'instagram.com',
    'youtube.com', 'tiktok.com', 'pinterest.com',
    'bit.ly', 'tinyurl.com', 't.co', 'goo.gl',
];

/**
 * Validate and clean a single contact
 * @param {Object} contact - Raw contact data
 * @returns {{contact: Object|null, valid: boolean, issues: Array}}
 */
function validateContact(contact) {
    const issues = [];
    const cleaned = { ...contact };
    
    // 1. Clean and validate email (REQUIRED)
    if (!contact.email) {
        return { contact: null, valid: false, issues: ['No email'] };
    }
    
    cleaned.email = cleanEmail(contact.email);
    
    if (!cleaned.email) {
        return { contact: null, valid: false, issues: ['Invalid email format'] };
    }
    
    if (isBlacklistedEmail(cleaned.email)) {
        return { contact: null, valid: false, issues: ['Blacklisted email'] };
    }
    
    // 2. Clean name
    if (contact.name) {
        cleaned.name = cleanName(contact.name);
        if (!cleaned.name) {
            issues.push('Name cleaned to empty');
        }
    }
    
    // 3. Clean company
    if (contact.company) {
        cleaned.company = cleanCompany(contact.company);
        if (!cleaned.company) {
            issues.push('Company cleaned to empty');
        }
    }
    
    // 4. Clean phone
    if (contact.phone) {
        cleaned.phone = cleanPhone(contact.phone);
        if (!cleaned.phone) {
            issues.push('Invalid phone removed');
        }
    }
    
    // 5. Clean website
    if (contact.website) {
        cleaned.website = cleanWebsite(contact.website);
        if (!cleaned.website) {
            issues.push('Invalid website removed');
        }
    }
    
    // 6. Clean country/city
    if (contact.country) {
        cleaned.country = cleanText(contact.country);
    }
    if (contact.city) {
        cleaned.city = cleanText(contact.city);
    }
    
    // 7. Clean title
    if (contact.title) {
        cleaned.title = cleanText(contact.title);
    }
    
    return {
        contact: cleaned,
        valid: true,
        issues
    };
}

/**
 * Validate array of contacts
 * @param {Array} contacts - Array of contacts
 * @returns {{valid: Array, invalid: Array, stats: Object}}
 */
function validateContacts(contacts) {
    const valid = [];
    const invalid = [];
    
    for (const contact of contacts) {
        const result = validateContact(contact);
        
        if (result.valid && result.contact) {
            valid.push(result.contact);
        } else {
            invalid.push({
                original: contact,
                issues: result.issues
            });
        }
    }
    
    return {
        valid,
        invalid,
        stats: {
            total: contacts.length,
            valid: valid.length,
            invalid: invalid.length
        }
    };
}

/**
 * Clean email address
 */
function cleanEmail(email) {
    if (!email || typeof email !== 'string') return null;
    
    let cleaned = email.toLowerCase().trim();
    
    // Remove trailing text (like "phone" stuck to email)
    // e.g., "suer@elanexpo.netphone" -> "suer@elanexpo.net"
    const emailMatch = cleaned.match(/^([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
    if (emailMatch) {
        cleaned = emailMatch[1];
    }
    
    // Remove common suffixes
    cleaned = cleaned
        .replace(/phone.*$/i, '')
        .replace(/tel.*$/i, '')
        .replace(/fax.*$/i, '')
        .replace(/[,;:\s]+$/, '')
        .trim();
    
    // Validate format
    if (!EMAIL_REGEX.test(cleaned)) {
        return null;
    }
    
    return cleaned;
}

/**
 * Check if email is blacklisted
 */
function isBlacklistedEmail(email) {
    if (!email) return true;
    
    const lower = email.toLowerCase();
    return EMAIL_BLACKLIST.some(b => lower.includes(b));
}

/**
 * Clean name
 */
function cleanName(name) {
    if (!name || typeof name !== 'string') return null;
    
    let cleaned = name.trim();
    
    // Remove labels if present
    cleaned = cleaned.replace(/^(name|contact|person|isim|ad)[\s:]+/i, '');
    
    // Remove embedded data (email, phone, company concatenated)
    // e.g., "Suer AYEmail: suer@..." -> "Suer AY"
    cleaned = cleaned.replace(/(email|phone|tel|company|firma)[\s:]+.*/i, '');
    
    // Remove zero-width characters
    cleaned = cleaned.replace(/[\u200B-\u200D\uFEFF]/g, '');
    
    // Check if looks like a valid name
    cleaned = cleaned.trim();
    
    if (cleaned.length < 2 || cleaned.length > 100) return null;
    
    // Should be mostly alphabetic
    if (!/^[A-Za-z\u00C0-\u024F\s\.\-']+$/.test(cleaned)) return null;
    
    // Title case if needed
    if (cleaned === cleaned.toUpperCase() || cleaned === cleaned.toLowerCase()) {
        cleaned = toTitleCase(cleaned);
    }
    
    return cleaned || null;
}

/**
 * Clean company name
 */
function cleanCompany(company) {
    if (!company || typeof company !== 'string') return null;
    
    let cleaned = company.trim();
    
    // Remove labels if present
    cleaned = cleaned.replace(/^(company|organization|firma|şirket)[\s:]+/i, '');
    
    // Remove embedded data
    cleaned = cleaned.replace(/(name|email|phone|tel|country)[\s:]+.*/i, '');
    
    // Remove zero-width characters
    cleaned = cleaned.replace(/[\u200B-\u200D\uFEFF]/g, '');
    
    cleaned = cleaned.trim();
    
    if (cleaned.length < 2 || cleaned.length > 200) return null;
    
    // Title case if all caps
    if (cleaned === cleaned.toUpperCase()) {
        cleaned = toTitleCase(cleaned);
    }
    
    return cleaned || null;
}

/**
 * Clean phone number
 */
function cleanPhone(phone) {
    if (!phone || typeof phone !== 'string') return null;
    
    let cleaned = phone.trim();
    
    // Remove labels
    cleaned = cleaned.replace(/^(phone|tel|mobile|gsm|telefon)[\s:]+/i, '');
    
    // Remove trailing text
    cleaned = cleaned.replace(/(country|ülke|email).*$/i, '');
    
    cleaned = cleaned.trim();
    
    // Basic validation
    const digits = cleaned.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) return null;
    
    // Should match phone pattern
    if (!PHONE_REGEX.test(cleaned)) return null;
    
    return cleaned;
}

/**
 * Clean website URL
 */
function cleanWebsite(website) {
    if (!website || typeof website !== 'string') return null;
    
    let cleaned = website.trim();
    
    // Remove labels
    cleaned = cleaned.replace(/^(website|web|url|site)[\s:]+/i, '');
    
    cleaned = cleaned.trim();
    
    // Skip file names that look like websites
    if (/\.(pdf|doc|docx|xls|xlsx|csv)$/i.test(cleaned)) return null;
    
    // Skip encoded file names
    if (/%20/.test(cleaned) && /\.(pdf|doc)/i.test(cleaned)) return null;
    
    // Check blacklist
    if (WEBSITE_BLACKLIST.some(b => cleaned.toLowerCase().includes(b))) {
        return null;
    }
    
    // Add protocol if missing
    if (!cleaned.startsWith('http') && cleaned.includes('.')) {
        if (cleaned.startsWith('www.')) {
            cleaned = 'https://' + cleaned;
        } else {
            cleaned = 'https://www.' + cleaned;
        }
    }
    
    // Basic URL validation
    try {
        new URL(cleaned);
        return cleaned;
    } catch {
        return null;
    }
}

/**
 * Generic text cleaner
 */
function cleanText(text) {
    if (!text || typeof text !== 'string') return null;
    
    let cleaned = text.trim()
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    
    return cleaned || null;
}

/**
 * Title case converter
 */
function toTitleCase(str) {
    return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

module.exports = {
    validateContact,
    validateContacts,
    cleanEmail,
    cleanName,
    cleanCompany,
    cleanPhone,
    cleanWebsite,
    cleanText,
    isBlacklistedEmail,
};
