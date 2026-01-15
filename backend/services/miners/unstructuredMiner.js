/**
 * Unstructured Miner
 * Fallback miner that finds emails and extracts context
 * Uses regex patterns to find data around emails
 */

const { FIELD_LABELS } = require('./labelPatterns');

// Patterns
const PATTERNS = {
    email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi,
    
    phone: [
        // International with country code
        /(?:\+|00)\s?[1-9]\d{0,2}[\s\-\.]?\(?\d{1,4}\)?[\s\-\.]?\d{2,4}[\s\-\.]?\d{2,4}[\s\-\.]?\d{0,4}/g,
        // Standard formats
        /\(?\d{3}\)?[\s\-\.]?\d{3}[\s\-\.]?\d{4}/g,
        // European style
        /\d{2,4}[\s\-\.]\d{2,4}[\s\-\.]\d{2,4}/g,
    ],
    
    website: /(?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9][-a-zA-Z0-9]{0,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}(?:\/[^\s]*)?/gi,
    
    // Email blacklist
    emailBlacklist: ['.png', '.jpg', '.jpeg', '.gif', '.svg', 'example.com', 'test.com', 'wix.com', 'sentry.io', 'noreply', 'no-reply', '.pdf'],
    
    // Generic email providers
    genericProviders: ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'mail.com'],
};

// Countries with keywords
const COUNTRIES = [
    { name: 'Turkey', keywords: ['turkey', 'türkiye', 'turkiye', 'istanbul', 'ankara', 'izmir', '+90'] },
    { name: 'Germany', keywords: ['germany', 'deutschland', 'berlin', 'munich', 'frankfurt', '+49'] },
    { name: 'France', keywords: ['france', 'paris', 'lyon', 'marseille', '+33'] },
    { name: 'United Kingdom', keywords: ['uk', 'united kingdom', 'england', 'london', '+44'] },
    { name: 'USA', keywords: ['usa', 'united states', 'america', 'new york', '+1'] },
    { name: 'Spain', keywords: ['spain', 'españa', 'madrid', 'barcelona', '+34'] },
    { name: 'Italy', keywords: ['italy', 'italia', 'rome', 'milan', '+39'] },
    { name: 'Netherlands', keywords: ['netherlands', 'holland', 'amsterdam', '+31'] },
    { name: 'UAE', keywords: ['uae', 'dubai', 'abu dhabi', 'emirates', '+971'] },
    { name: 'Saudi Arabia', keywords: ['saudi', 'riyadh', 'jeddah', '+966'] },
    { name: 'China', keywords: ['china', 'beijing', 'shanghai', '+86'] },
    { name: 'India', keywords: ['india', 'mumbai', 'delhi', 'bangalore', '+91'] },
    { name: 'Ghana', keywords: ['ghana', 'accra', 'kumasi', '+233'] },
    { name: 'Nigeria', keywords: ['nigeria', 'lagos', 'abuja', '+234'] },
    { name: 'South Africa', keywords: ['south africa', 'johannesburg', 'cape town', '+27'] },
    { name: 'Brazil', keywords: ['brazil', 'brasil', 'são paulo', '+55'] },
    { name: 'Russia', keywords: ['russia', 'россия', 'moscow', 'москва', '+7'] },
    { name: 'Japan', keywords: ['japan', '日本', 'tokyo', '+81'] },
    { name: 'Korea', keywords: ['korea', '한국', 'seoul', '+82'] },
];

/**
 * Main mining function
 * @param {string} text - Document text
 * @returns {{contacts: Array, stats: Object}}
 */
function mine(text) {
    if (!text || typeof text !== 'string') {
        return { contacts: [], stats: { method: 'unstructured', emails: 0 } };
    }

    console.log(`   [UnstructuredMiner] Processing ${text.length} chars`);

    const lines = text.split(/\r?\n/);
    const contacts = [];
    const processedEmails = new Set();
    
    // Find all emails and their context
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const emailMatches = line.match(PATTERNS.email) || [];
        
        for (const email of emailMatches) {
            const emailLower = email.toLowerCase().trim();
            
            // Skip duplicates and blacklisted
            if (processedEmails.has(emailLower)) continue;
            if (!isValidEmail(emailLower)) continue;
            
            processedEmails.add(emailLower);
            
            // Get context (lines above and below)
            const contextStart = Math.max(0, i - 8);
            const contextEnd = Math.min(lines.length - 1, i + 4);
            const contextLines = lines.slice(contextStart, contextEnd + 1);
            const contextText = contextLines.join('\n');
            
            // Extract data from context
            const contact = {
                email: emailLower,
                company: null,
                name: null,
                phone: extractPhone(contextText),
                website: extractWebsite(contextText, emailLower),
                country: detectCountry(contextText),
                city: null,
                title: null,
            };
            
            // Try to find name and company from context
            const extracted = extractNameAndCompany(contextLines, i - contextStart);
            contact.name = extracted.name;
            contact.company = extracted.company;
            
            contacts.push(contact);
        }
    }
    
    console.log(`   [UnstructuredMiner] Found ${contacts.length} contacts from ${processedEmails.size} emails`);

    return {
        contacts,
        stats: {
            method: 'unstructured',
            emails: processedEmails.size,
            contacts: contacts.length
        }
    };
}

/**
 * Extract name and company from context lines
 */
function extractNameAndCompany(lines, emailLineIndex) {
    const result = { name: null, company: null };
    
    // Look at lines before email
    for (let i = emailLineIndex - 1; i >= 0 && i >= emailLineIndex - 5; i--) {
        const line = lines[i].trim();
        if (!line || line.length < 2 || line.length > 100) continue;
        
        // Skip if it's a label line (contains :)
        if (/:\s*$/.test(line)) continue;
        
        // Skip if it looks like a phone or email
        if (PATTERNS.email.test(line)) continue;
        if (/^[\d\s\+\-\(\)]+$/.test(line)) continue;
        
        // Check for company indicators
        if (/\b(ltd|inc|corp|llc|gmbh|ag|co\.|company|limited|group|plc)\b/i.test(line)) {
            if (!result.company) result.company = cleanText(line);
            continue;
        }
        
        // Check if it's all caps (likely company name)
        if (line === line.toUpperCase() && line.length > 3 && /[A-Z]/.test(line)) {
            if (!result.company) result.company = toTitleCase(line);
            continue;
        }
        
        // Check if looks like a person name (2-4 words, alphabetic)
        if (/^[A-Za-z\u00C0-\u024F\s\.]+$/.test(line)) {
            const words = line.split(/\s+/).filter(w => w.length > 1);
            if (words.length >= 2 && words.length <= 4) {
                if (!result.name) result.name = cleanText(line);
            }
        }
    }
    
    // If no company found, derive from email
    if (!result.company) {
        const emailLine = lines[emailLineIndex] || '';
        const emailMatch = emailLine.match(PATTERNS.email);
        if (emailMatch) {
            result.company = deriveCompanyFromEmail(emailMatch[0]);
        }
    }
    
    return result;
}

/**
 * Extract phone from text
 */
function extractPhone(text) {
    for (const pattern of PATTERNS.phone) {
        const matches = text.match(pattern);
        if (matches && matches.length > 0) {
            const phone = matches[0].trim();
            const digits = phone.replace(/\D/g, '');
            if (digits.length >= 8 && digits.length <= 15) {
                return phone;
            }
        }
    }
    return null;
}

/**
 * Extract website from text
 */
function extractWebsite(text, email) {
    // First try to find explicit URL
    const urlMatches = text.match(PATTERNS.website);
    if (urlMatches) {
        for (const url of urlMatches) {
            const lower = url.toLowerCase();
            // Skip social media
            if (/facebook|twitter|linkedin|instagram|youtube/i.test(lower)) continue;
            // Skip file extensions
            if (/\.(pdf|doc|xls|jpg|png)/i.test(lower)) continue;
            
            let clean = url.trim();
            if (!clean.startsWith('http')) {
                clean = 'https://' + clean;
            }
            return clean;
        }
    }
    
    // Derive from email
    return deriveWebsiteFromEmail(email);
}

/**
 * Detect country from text
 */
function detectCountry(text) {
    const lower = text.toLowerCase();
    
    for (const country of COUNTRIES) {
        for (const keyword of country.keywords) {
            if (lower.includes(keyword.toLowerCase())) {
                return country.name;
            }
        }
    }
    
    return null;
}

/**
 * Derive company name from email
 */
function deriveCompanyFromEmail(email) {
    if (!email) return null;
    
    const parts = email.split('@');
    if (parts.length !== 2) return null;
    
    const domain = parts[1].toLowerCase();
    
    // Skip generic providers
    if (PATTERNS.genericProviders.includes(domain)) {
        return null;
    }
    
    // Extract company name from domain
    const domainParts = domain.split('.');
    if (domainParts.length >= 2) {
        const name = domainParts[0];
        return toTitleCase(name);
    }
    
    return null;
}

/**
 * Derive website from email
 */
function deriveWebsiteFromEmail(email) {
    if (!email) return null;
    
    const parts = email.split('@');
    if (parts.length !== 2) return null;
    
    const domain = parts[1].toLowerCase();
    
    if (PATTERNS.genericProviders.includes(domain)) {
        return null;
    }
    
    return 'https://www.' + domain;
}

/**
 * Check if email is valid
 */
function isValidEmail(email) {
    if (!email) return false;
    if (email.length < 5 || !email.includes('@')) return false;
    
    const lower = email.toLowerCase();
    
    // Check blacklist
    if (PATTERNS.emailBlacklist.some(b => lower.includes(b))) {
        return false;
    }
    
    // Basic format check
    return PATTERNS.email.test(email);
}

/**
 * Clean text
 */
function cleanText(text) {
    if (!text) return '';
    return text.trim()
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, ' ');
}

/**
 * Convert to title case
 */
function toTitleCase(str) {
    return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

module.exports = {
    mine,
    extractPhone,
    extractWebsite,
    detectCountry,
    extractNameAndCompany,
    deriveCompanyFromEmail,
    isValidEmail,
};
