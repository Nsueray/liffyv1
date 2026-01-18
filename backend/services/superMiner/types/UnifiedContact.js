/**
 * UnifiedContact.js - SuperMiner v3.1
 * 
 * Standart contact schema tüm miner'lar için.
 * Her miner bu formata dönüştürür, Aggregator bu formatı kullanır.
 * 
 * KURALLAR:
 * - Tüm field'lar optional (email hariç)
 * - confidence her zaman 0-100 arası
 * - source hangi miner'dan geldiğini belirtir
 * - evidence AI için zorunlu (hallucination önleme)
 */

// Confidence score limitleri
const CONFIDENCE = {
    MIN: 0,
    MAX: 100,
    AI_DEFAULT: 70,
    REGEX_DEFAULT: 50,
    PLAYWRIGHT_DEFAULT: 60,
    HTTP_DEFAULT: 40
};

// Geçerli source değerleri
const VALID_SOURCES = [
    'httpBasicMiner',
    'playwrightMiner',
    'playwrightTableMiner',
    'aiMiner',
    'websiteScraperMiner',
    'fileMiner',
    'manual',
    'import'
];

// Email tipi (personal vs generic)
const EMAIL_TYPES = {
    PERSONAL: 'personal',      // john@company.com
    GENERIC: 'generic',        // info@company.com, sales@company.com
    ROLE: 'role',              // ceo@company.com, hr@company.com
    UNKNOWN: 'unknown'
};

// Generic email patterns
const GENERIC_EMAIL_PATTERNS = [
    /^info@/i,
    /^contact@/i,
    /^sales@/i,
    /^support@/i,
    /^hello@/i,
    /^enquiry@/i,
    /^enquiries@/i,
    /^office@/i,
    /^admin@/i,
    /^mail@/i,
    /^general@/i
];

// Role email patterns
const ROLE_EMAIL_PATTERNS = [
    /^ceo@/i,
    /^cfo@/i,
    /^cto@/i,
    /^hr@/i,
    /^marketing@/i,
    /^pr@/i,
    /^legal@/i,
    /^accounting@/i
];

/**
 * Detect email type
 * @param {string} email 
 * @returns {string} EMAIL_TYPES value
 */
function detectEmailType(email) {
    if (!email) return EMAIL_TYPES.UNKNOWN;
    
    const lower = email.toLowerCase();
    
    if (GENERIC_EMAIL_PATTERNS.some(p => p.test(lower))) {
        return EMAIL_TYPES.GENERIC;
    }
    
    if (ROLE_EMAIL_PATTERNS.some(p => p.test(lower))) {
        return EMAIL_TYPES.ROLE;
    }
    
    // Has name-like prefix (not just numbers/generic)
    const prefix = lower.split('@')[0];
    if (prefix && /^[a-z]+[._]?[a-z]+$/i.test(prefix)) {
        return EMAIL_TYPES.PERSONAL;
    }
    
    return EMAIL_TYPES.UNKNOWN;
}

/**
 * UnifiedContact schema
 */
class UnifiedContact {
    constructor(data = {}) {
        // === REQUIRED ===
        this.email = data.email?.toLowerCase()?.trim() || null;
        
        // === IDENTITY ===
        this.contactName = data.contactName || data.contact_name || data.name || null;
        this.jobTitle = data.jobTitle || data.job_title || data.title || null;
        
        // === COMPANY ===
        this.companyName = data.companyName || data.company_name || data.company || null;
        this.website = data.website || null;
        
        // === LOCATION ===
        this.country = data.country || null;
        this.city = data.city || null;
        this.address = data.address || null;
        
        // === CONTACT ===
        this.phone = data.phone || null;
        this.additionalEmails = data.additionalEmails || [];
        
        // === METADATA ===
        this.source = data.source || 'unknown';
        this.sourceUrl = data.sourceUrl || data.source_url || null;
        this.confidence = this._normalizeConfidence(data.confidence);
        this.emailType = detectEmailType(this.email);
        
        // === AI SPECIFIC (v4 roadmap için hazırlık) ===
        this.evidence = data.evidence || null;  // AI'ın bulduğu kanıt (mailto link, table cell, etc.)
        
        // === TIMESTAMPS ===
        this.extractedAt = data.extractedAt || new Date().toISOString();
        
        // === RAW DATA (debug için) ===
        this.raw = data.raw || null;
    }
    
    /**
     * Normalize confidence to 0-100
     */
    _normalizeConfidence(value) {
        if (value === null || value === undefined) {
            return CONFIDENCE.REGEX_DEFAULT;
        }
        
        const num = Number(value);
        if (isNaN(num)) return CONFIDENCE.REGEX_DEFAULT;
        
        return Math.max(CONFIDENCE.MIN, Math.min(CONFIDENCE.MAX, Math.round(num)));
    }
    
    /**
     * Check if contact is valid (has email)
     */
    isValid() {
        return this.email && this.email.includes('@');
    }
    
    /**
     * Check if contact has rich data (name + company)
     */
    isRich() {
        return this.isValid() && this.contactName && this.companyName;
    }
    
    /**
     * Get quality score (0-100)
     */
    getQualityScore() {
        let score = 0;
        
        if (this.email) score += 30;
        if (this.contactName) score += 20;
        if (this.companyName) score += 15;
        if (this.phone) score += 15;
        if (this.website) score += 5;
        if (this.country) score += 5;
        if (this.jobTitle) score += 5;
        if (this.city) score += 3;
        if (this.address) score += 2;
        
        return Math.min(100, score);
    }
    
    /**
     * Convert to plain object (for DB insert)
     */
    toObject() {
        return {
            email: this.email,
            contact_name: this.contactName,
            job_title: this.jobTitle,
            company_name: this.companyName,
            website: this.website,
            country: this.country,
            city: this.city,
            address: this.address,
            phone: this.phone,
            additional_emails: this.additionalEmails,
            source: this.source,
            source_url: this.sourceUrl,
            confidence: this.confidence,
            email_type: this.emailType,
            evidence: this.evidence,
            extracted_at: this.extractedAt,
            raw: this.raw
        };
    }
    
    /**
     * Convert to DB-ready format (mining_results table)
     */
    toDBFormat(jobId, organizerId) {
        return {
            job_id: jobId,
            organizer_id: organizerId,
            source_url: this.sourceUrl,
            company_name: this.companyName,
            contact_name: this.contactName,
            job_title: this.jobTitle,
            phone: this.phone,
            country: this.country,
            city: this.city,
            address: this.address,
            website: this.website,
            emails: this.email ? [this.email, ...this.additionalEmails] : [],
            confidence_score: this.confidence,
            raw: JSON.stringify({
                source: this.source,
                email_type: this.emailType,
                evidence: this.evidence,
                extracted_at: this.extractedAt,
                quality_score: this.getQualityScore()
            })
        };
    }
    
    /**
     * Create from legacy miner result
     */
    static fromLegacy(data, source) {
        return new UnifiedContact({
            email: data.email || (data.emails && data.emails[0]),
            contactName: data.contactName || data.contact_name || data.name,
            jobTitle: data.jobTitle || data.job_title || data.title,
            companyName: data.companyName || data.company_name || data.company,
            website: data.website,
            country: data.country,
            city: data.city,
            address: data.address,
            phone: data.phone,
            additionalEmails: data.emails?.slice(1) || [],
            source: source,
            sourceUrl: data.sourceUrl || data.source_url,
            confidence: data.confidence || data.confidence_score,
            evidence: data.evidence,
            raw: data.raw || data
        });
    }
    
    /**
     * Merge two contacts (for Aggregator)
     * Preserves the richer/more confident values
     */
    static merge(contact1, contact2) {
        if (!contact1) return contact2;
        if (!contact2) return contact1;
        
        // Pick higher confidence as base
        const [base, other] = contact1.confidence >= contact2.confidence 
            ? [contact1, contact2] 
            : [contact2, contact1];
        
        return new UnifiedContact({
            // Use base email
            email: base.email || other.email,
            
            // Prefer non-null values, then longer strings
            contactName: pickBest(base.contactName, other.contactName),
            jobTitle: pickBest(base.jobTitle, other.jobTitle),
            companyName: pickBest(base.companyName, other.companyName),
            website: pickBest(base.website, other.website),
            country: pickBest(base.country, other.country),
            city: pickBest(base.city, other.city),
            address: pickBest(base.address, other.address),
            phone: pickBest(base.phone, other.phone),
            
            // Merge additional emails
            additionalEmails: [...new Set([
                ...base.additionalEmails,
                ...other.additionalEmails
            ])],
            
            // Metadata: higher confidence wins
            source: base.source,
            sourceUrl: base.sourceUrl || other.sourceUrl,
            confidence: Math.max(base.confidence, other.confidence),
            evidence: base.evidence || other.evidence,
            
            // Keep both raws
            raw: { base: base.raw, merged: other.raw }
        });
    }
}

/**
 * Pick better string value (non-null, longer)
 */
function pickBest(a, b) {
    if (!a && !b) return null;
    if (!a) return b;
    if (!b) return a;
    
    // Prefer longer string (usually more detailed)
    return String(a).length >= String(b).length ? a : b;
}

/**
 * Create signature for deduplication
 */
function createSignature(contact) {
    if (!contact || !contact.email) return null;
    return contact.email.toLowerCase().trim();
}

module.exports = {
    UnifiedContact,
    CONFIDENCE,
    VALID_SOURCES,
    EMAIL_TYPES,
    detectEmailType,
    createSignature,
    pickBest
};
