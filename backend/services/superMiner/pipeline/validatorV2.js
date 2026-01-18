/**
 * validatorV2.js - SuperMiner v3.1
 * 
 * Context-aware contact validation.
 * 
 * KURALLAR:
 * - Mevcut validators/ klasörüne DOKUNULMAZ
 * - Context-aware confidence scoring
 * - Email type awareness (personal vs generic)
 * - Garbage email filtering
 * - Field-level validation
 */

const { UnifiedContact, EMAIL_TYPES, CONFIDENCE } = require('../types/UnifiedContact');

// ============================================
// EMAIL BLACKLISTS
// ============================================

// Garbage emails (system/tracking)
const GARBAGE_EMAIL_PATTERNS = [
    // Tracking pixels
    /wix\.com$/i,
    /sentry\.io$/i,
    /hotjar\.com$/i,
    /googletagmanager\.com$/i,
    /google-analytics\.com$/i,
    /facebook\.com$/i,
    /twitter\.com$/i,
    /linkedin\.com$/i,
    
    // CDN/Tech
    /cloudflare\.com$/i,
    /amazonaws\.com$/i,
    /azure\.com$/i,
    /github\.com$/i,
    /gitlab\.com$/i,
    
    // Generic providers (when used as company email = suspicious)
    /noreply@/i,
    /no-reply@/i,
    /donotreply@/i,
    /mailer-daemon@/i,
    /postmaster@/i,
    
    // Test/Example
    /example\.com$/i,
    /test\.com$/i,
    /localhost/i,
    /@example\./i,
    /@test\./i,
    
    // Spam indicators
    /\d{6,}@/,  // 6+ consecutive digits before @
    /^[a-z]{1,2}\d+@/i,  // Single letter + numbers
];

// Domain blacklist
const DOMAIN_BLACKLIST = [
    'mailinator.com',
    'guerrillamail.com',
    'tempmail.com',
    'throwaway.email',
    'fakeinbox.com',
    '10minutemail.com',
    'temp-mail.org',
    'sharklasers.com',
    'yopmail.com'
];

// Generic email providers (not blacklisted, but affects scoring)
const GENERIC_PROVIDERS = [
    'gmail.com',
    'yahoo.com',
    'hotmail.com',
    'outlook.com',
    'aol.com',
    'icloud.com',
    'mail.com',
    'yandex.com',
    'protonmail.com',
    'zoho.com',
    'gmx.com',
    'live.com'
];

// ============================================
// VALIDATION FUNCTIONS
// ============================================

/**
 * Check if email is garbage (should be completely rejected)
 * @param {string} email 
 * @returns {boolean}
 */
function isGarbageEmail(email) {
    if (!email) return true;
    
    const lower = email.toLowerCase().trim();
    
    // Pattern check
    if (GARBAGE_EMAIL_PATTERNS.some(pattern => pattern.test(lower))) {
        return true;
    }
    
    // Domain blacklist
    const domain = lower.split('@')[1];
    if (domain && DOMAIN_BLACKLIST.includes(domain)) {
        return true;
    }
    
    // Too short email prefix (likely auto-generated)
    const prefix = lower.split('@')[0];
    if (prefix && prefix.length < 2) {
        return true;
    }
    
    // Invalid format
    if (!lower.includes('@') || !lower.includes('.')) {
        return true;
    }
    
    return false;
}

/**
 * Check if email is from generic provider
 * @param {string} email 
 * @returns {boolean}
 */
function isGenericProviderEmail(email) {
    if (!email) return false;
    
    const domain = email.toLowerCase().split('@')[1];
    return domain && GENERIC_PROVIDERS.includes(domain);
}

/**
 * Validate email format
 * @param {string} email 
 * @returns {{valid: boolean, cleaned: string|null, issues: string[]}}
 */
function validateEmail(email) {
    const issues = [];
    
    if (!email || typeof email !== 'string') {
        return { valid: false, cleaned: null, issues: ['No email provided'] };
    }
    
    let cleaned = email.toLowerCase().trim();
    
    // Remove common trailing garbage
    cleaned = cleaned
        .replace(/[,;:\s]+$/, '')
        .replace(/phone.*$/i, '')
        .replace(/tel.*$/i, '')
        .replace(/fax.*$/i, '')
        .trim();
    
    // Extract email from string (might have surrounding text)
    const emailMatch = cleaned.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
    if (emailMatch) {
        cleaned = emailMatch[1];
    }
    
    // Basic format validation
    const emailRegex = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
    if (!emailRegex.test(cleaned)) {
        return { valid: false, cleaned: null, issues: ['Invalid email format'] };
    }
    
    // Garbage check
    if (isGarbageEmail(cleaned)) {
        return { valid: false, cleaned: null, issues: ['Garbage/blacklisted email'] };
    }
    
    // Generic provider warning (not invalid, just noted)
    if (isGenericProviderEmail(cleaned)) {
        issues.push('Generic email provider');
    }
    
    return { valid: true, cleaned, issues };
}

/**
 * Validate phone number
 * @param {string} phone 
 * @returns {{valid: boolean, cleaned: string|null, issues: string[]}}
 */
function validatePhone(phone) {
    if (!phone || typeof phone !== 'string') {
        return { valid: false, cleaned: null, issues: [] };
    }
    
    let cleaned = phone.trim();
    
    // Remove labels
    cleaned = cleaned.replace(/^(phone|tel|mobile|gsm|fax)[\s:]+/i, '');
    
    // Extract digits
    const digits = cleaned.replace(/\D/g, '');
    
    // Basic validation
    if (digits.length < 7 || digits.length > 15) {
        return { valid: false, cleaned: null, issues: ['Invalid phone length'] };
    }
    
    // Looks like a year?
    if (/^(19|20)\d{2}$/.test(digits)) {
        return { valid: false, cleaned: null, issues: ['Looks like a year, not phone'] };
    }
    
    return { valid: true, cleaned, issues: [] };
}

/**
 * Validate website URL
 * @param {string} website 
 * @returns {{valid: boolean, cleaned: string|null, issues: string[]}}
 */
function validateWebsite(website) {
    if (!website || typeof website !== 'string') {
        return { valid: false, cleaned: null, issues: [] };
    }
    
    let cleaned = website.trim();
    
    // Remove labels
    cleaned = cleaned.replace(/^(website|web|url|site)[\s:]+/i, '');
    
    // Skip file names that look like websites
    if (/\.(pdf|doc|docx|xls|xlsx|csv)$/i.test(cleaned)) {
        return { valid: false, cleaned: null, issues: ['File path, not website'] };
    }
    
    // Add protocol if missing
    if (!cleaned.startsWith('http') && cleaned.includes('.')) {
        cleaned = cleaned.startsWith('www.') 
            ? 'https://' + cleaned 
            : 'https://www.' + cleaned;
    }
    
    // Validate URL
    try {
        const url = new URL(cleaned);
        
        // Blacklist check
        const blacklist = ['shorturl.at', 'bit.ly', 'tinyurl.com', 't.co', 'goo.gl'];
        if (blacklist.some(b => url.hostname.includes(b))) {
            return { valid: false, cleaned: null, issues: ['URL shortener'] };
        }
        
        return { valid: true, cleaned, issues: [] };
        
    } catch {
        return { valid: false, cleaned: null, issues: ['Invalid URL format'] };
    }
}

/**
 * Validate name
 * @param {string} name 
 * @returns {{valid: boolean, cleaned: string|null, issues: string[]}}
 */
function validateName(name) {
    if (!name || typeof name !== 'string') {
        return { valid: false, cleaned: null, issues: [] };
    }
    
    let cleaned = name.trim();
    
    // Remove labels
    cleaned = cleaned.replace(/^(name|contact|person)[\s:]+/i, '');
    
    // Remove embedded data
    cleaned = cleaned.replace(/(email|phone|company)[\s:]+.*/i, '');
    
    // Remove zero-width characters
    cleaned = cleaned.replace(/[\u200B-\u200D\uFEFF]/g, '');
    
    cleaned = cleaned.trim();
    
    // Length check
    if (cleaned.length < 2 || cleaned.length > 100) {
        return { valid: false, cleaned: null, issues: ['Invalid name length'] };
    }
    
    // Should be mostly alphabetic (allows international chars)
    if (!/^[\p{L}\s.\-']+$/u.test(cleaned)) {
        return { valid: false, cleaned: null, issues: ['Name contains invalid characters'] };
    }
    
    // Title case if needed
    if (cleaned === cleaned.toUpperCase() || cleaned === cleaned.toLowerCase()) {
        cleaned = cleaned.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    }
    
    return { valid: true, cleaned, issues: [] };
}

/**
 * Validate company name
 * @param {string} company 
 * @returns {{valid: boolean, cleaned: string|null, issues: string[]}}
 */
function validateCompany(company) {
    if (!company || typeof company !== 'string') {
        return { valid: false, cleaned: null, issues: [] };
    }
    
    let cleaned = company.trim();
    
    // Remove labels
    cleaned = cleaned.replace(/^(company|organization|firma)[\s:]+/i, '');
    
    // Remove embedded data
    cleaned = cleaned.replace(/(name|email|phone|country)[\s:]+.*/i, '');
    
    // Remove zero-width characters
    cleaned = cleaned.replace(/[\u200B-\u200D\uFEFF]/g, '');
    
    cleaned = cleaned.trim();
    
    // Length check
    if (cleaned.length < 2 || cleaned.length > 200) {
        return { valid: false, cleaned: null, issues: ['Invalid company length'] };
    }
    
    // Title case if all caps
    if (cleaned === cleaned.toUpperCase() && cleaned.length > 5) {
        cleaned = cleaned.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    }
    
    return { valid: true, cleaned, issues: [] };
}

// ============================================
// MAIN VALIDATOR
// ============================================

/**
 * Validate and clean a UnifiedContact
 * @param {UnifiedContact|Object} contact 
 * @returns {{valid: boolean, contact: UnifiedContact|null, issues: string[], score: number}}
 */
function validateContact(contact) {
    const issues = [];
    
    if (!contact) {
        return { valid: false, contact: null, issues: ['No contact provided'], score: 0 };
    }
    
    // Email is required
    const emailResult = validateEmail(contact.email);
    if (!emailResult.valid) {
        return { 
            valid: false, 
            contact: null, 
            issues: emailResult.issues, 
            score: 0 
        };
    }
    
    // Create cleaned contact
    const cleaned = {
        email: emailResult.cleaned,
        contactName: null,
        jobTitle: contact.jobTitle || contact.job_title || null,
        companyName: null,
        website: null,
        country: contact.country || null,
        city: contact.city || null,
        address: contact.address || null,
        phone: null,
        source: contact.source || 'unknown',
        sourceUrl: contact.sourceUrl || contact.source_url || null,
        confidence: contact.confidence || CONFIDENCE.REGEX_DEFAULT,
        evidence: contact.evidence || null,
        raw: contact.raw || null
    };
    
    // Validate optional fields
    const nameResult = validateName(contact.contactName || contact.contact_name || contact.name);
    if (nameResult.valid) {
        cleaned.contactName = nameResult.cleaned;
    }
    issues.push(...nameResult.issues);
    
    const companyResult = validateCompany(contact.companyName || contact.company_name || contact.company);
    if (companyResult.valid) {
        cleaned.companyName = companyResult.cleaned;
    }
    issues.push(...companyResult.issues);
    
    const phoneResult = validatePhone(contact.phone);
    if (phoneResult.valid) {
        cleaned.phone = phoneResult.cleaned;
    }
    issues.push(...phoneResult.issues);
    
    const websiteResult = validateWebsite(contact.website);
    if (websiteResult.valid) {
        cleaned.website = websiteResult.cleaned;
    }
    issues.push(...websiteResult.issues);
    
    // Add email issues
    issues.push(...emailResult.issues);
    
    // Create UnifiedContact
    const unifiedContact = new UnifiedContact(cleaned);
    
    // Calculate quality score
    const score = unifiedContact.getQualityScore();
    
    return {
        valid: true,
        contact: unifiedContact,
        issues,
        score
    };
}

/**
 * Validate array of contacts
 * @param {Array} contacts 
 * @returns {{valid: UnifiedContact[], invalid: Object[], stats: Object}}
 */
function validateContacts(contacts) {
    if (!Array.isArray(contacts)) {
        return { valid: [], invalid: [], stats: { total: 0, valid: 0, invalid: 0 } };
    }
    
    const valid = [];
    const invalid = [];
    let totalScore = 0;
    
    for (const contact of contacts) {
        const result = validateContact(contact);
        
        if (result.valid && result.contact) {
            valid.push(result.contact);
            totalScore += result.score;
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
            invalid: invalid.length,
            avgScore: valid.length > 0 ? Math.round(totalScore / valid.length) : 0
        }
    };
}

module.exports = {
    // Main functions
    validateContact,
    validateContacts,
    
    // Individual validators
    validateEmail,
    validatePhone,
    validateWebsite,
    validateName,
    validateCompany,
    
    // Helpers
    isGarbageEmail,
    isGenericProviderEmail,
    
    // Constants
    GARBAGE_EMAIL_PATTERNS,
    DOMAIN_BLACKLIST,
    GENERIC_PROVIDERS
};
