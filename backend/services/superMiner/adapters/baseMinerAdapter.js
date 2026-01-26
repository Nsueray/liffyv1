/**
 * baseMinerAdapter.js - SuperMiner v3.1
 * 
 * Base class for all miner adapters.
 * Tüm miner'lar bu interface'i implement eder.
 * 
 * KURALLAR:
 * - Mevcut miner'lar DEĞİŞMEZ
 * - Bu adapter onları wrap eder
 * - Ortak interface sağlar
 * - Cost tracking hooks
 * - Result normalization to UnifiedContact
 */

const { UnifiedContact, CONFIDENCE, VALID_SOURCES } = require('../types/UnifiedContact');
const { validateContacts } = require('../pipeline/validatorV2');
const { filterHallucinations, createEvidence, EVIDENCE_TYPES } = require('../pipeline/hallucinationFilter');

// ============================================
// MINER CAPABILITIES
// ============================================

const MINER_CAPABILITIES = {
    httpBasicMiner: {
        useCache: true,
        supportsPagination: false,
        supportsDetailPages: false,
        costPerRequest: 0,
        defaultConfidence: CONFIDENCE.HTTP_DEFAULT
    },
    playwrightMiner: {
        useCache: false,  // ASLA cache kullanmaz
        supportsPagination: true,
        supportsDetailPages: true,
        costPerRequest: 0,
        defaultConfidence: CONFIDENCE.PLAYWRIGHT_DEFAULT
    },
    playwrightTableMiner: {
        useCache: false,  // ASLA cache kullanmaz
        supportsPagination: false,
        supportsDetailPages: false,
        costPerRequest: 0,
        defaultConfidence: CONFIDENCE.PLAYWRIGHT_DEFAULT
    },
    aiMiner: {
        useCache: true,   // HTML cache kullanabilir
        supportsPagination: false,
        supportsDetailPages: true,
        costPerRequest: 0.01,  // ~$0.01 per page (estimate)
        defaultConfidence: CONFIDENCE.AI_DEFAULT
    },
    websiteScraperMiner: {
        useCache: false,  // Fresh fetch zorunlu
        supportsPagination: false,
        supportsDetailPages: true,
        costPerRequest: 0,
        defaultConfidence: CONFIDENCE.PLAYWRIGHT_DEFAULT
    },
    documentMiner: {
        useCache: true,
        supportsPagination: false,
        supportsDetailPages: false,
        costPerRequest: 0,
        defaultConfidence: 70
    }
};

// ============================================
// BASE ADAPTER CLASS
// ============================================

class BaseMinerAdapter {
    /**
     * @param {string} name - Miner name (must be in VALID_SOURCES)
     * @param {Function} minerFn - Original miner function
     * @param {Object} options - Adapter options
     */
    constructor(name, minerFn, options = {}) {
        if (!VALID_SOURCES.includes(name)) {
            console.warn(`[BaseMinerAdapter] Unknown miner name: ${name}`);
        }
        
        this.name = name;
        this.minerFn = minerFn;
        this.options = options;
        
        // Get capabilities
        this.capabilities = MINER_CAPABILITIES[name] || {
            useCache: false,
            supportsPagination: false,
            supportsDetailPages: false,
            costPerRequest: 0,
            defaultConfidence: CONFIDENCE.REGEX_DEFAULT
        };
        
        // Stats
        this.stats = {
            totalCalls: 0,
            successCalls: 0,
            failedCalls: 0,
            totalCost: 0,
            totalContacts: 0,
            lastCallAt: null
        };
        
        console.log(`[BaseMinerAdapter] Created adapter for ${name} (cache: ${this.capabilities.useCache})`);
    }
    
    /**
     * Check if miner should use cache
     * @returns {boolean}
     */
    shouldUseCache() {
        return this.capabilities.useCache;
    }
    
    /**
     * Get estimated cost for a request
     * @param {number} pageCount - Number of pages
     * @returns {number}
     */
    getEstimatedCost(pageCount = 1) {
        return this.capabilities.costPerRequest * pageCount;
    }
    
    /**
     * Run the miner with unified interface
     * @param {Object} job - Mining job
     * @param {Object} context - Execution context
     * @returns {Promise<Object>} Unified result
     */
    async mine(job, context = {}) {
        const startTime = Date.now();
        this.stats.totalCalls++;
        this.stats.lastCallAt = new Date().toISOString();
        
        console.log(`[${this.name}] Starting mining for job ${job.id}`);
        
        try {
            // Call original miner
            const rawResult = await this.minerFn(job);
            
            // Normalize result
            const normalizedResult = this.normalizeResult(rawResult, job);
            
            // Update stats
            this.stats.successCalls++;
            this.stats.totalCost += this.getEstimatedCost();
            this.stats.totalContacts += normalizedResult.contacts.length;
            
            const executionTime = Date.now() - startTime;
            
            console.log(`[${this.name}] Completed in ${executionTime}ms: ${normalizedResult.contacts.length} contacts`);
            
            return {
                ...normalizedResult,
                meta: {
                    ...normalizedResult.meta,
                    miner: this.name,
                    executionTime,
                    useCache: this.shouldUseCache(),
                    estimatedCost: this.getEstimatedCost()
                }
            };
            
        } catch (err) {
            this.stats.failedCalls++;
            
            const executionTime = Date.now() - startTime;
            
            console.error(`[${this.name}] Error in ${executionTime}ms:`, err.message);
            
            return {
                status: this.detectErrorStatus(err),
                contacts: [],
                emails: [],
                meta: {
                    miner: this.name,
                    executionTime,
                    error: err.message
                }
            };
        }
    }
    
    /**
     * Normalize miner result to unified format
     * @param {Object} rawResult - Raw miner result
     * @param {Object} job - Mining job
     * @returns {Object} Normalized result
     */
    normalizeResult(rawResult, job) {
        if (!rawResult) {
            return {
                status: 'ERROR',
                contacts: [],
                emails: [],
                meta: { note: 'Miner returned null' }
            };
        }
        
        // Extract contacts from various formats
        let rawContacts = [];
        
        if (Array.isArray(rawResult.contacts)) {
            rawContacts = rawResult.contacts;
        } else if (Array.isArray(rawResult.emails)) {
            // Convert emails-only result to contacts
            rawContacts = rawResult.emails.map(email => ({
                email: typeof email === 'string' ? email : email.email
            }));
        }
        
        // Convert to UnifiedContact
        const unifiedContacts = rawContacts.map(contact => {
            // Add evidence if available
            const evidence = this.extractEvidence(contact, rawResult);
            
            return UnifiedContact.fromLegacy({
                ...contact,
                source: this.name,
                sourceUrl: job.input,
                confidence: contact.confidence || this.capabilities.defaultConfidence,
                evidence
            }, this.name);
        });
        
        // Validate contacts
        const validationResult = validateContacts(unifiedContacts);
        
        // Filter hallucinations (only for AI miner)
        let finalContacts = validationResult.valid;
        let filterStats = null;
        
        if (this.name === 'aiMiner') {
            const hallucinationResult = filterHallucinations(finalContacts, {
                rejectHallucinations: true,
                minConfidence: 30,
                adjustConfidence: true
            });
            
            finalContacts = hallucinationResult.passed;
            filterStats = hallucinationResult.stats;
        }
        
        // Collect all emails
        const allEmails = new Set();
        for (const contact of finalContacts) {
            if (contact.email) allEmails.add(contact.email);
            if (contact.additionalEmails) {
                contact.additionalEmails.forEach(e => allEmails.add(e));
            }
        }
        
        // Also add raw emails from result
        if (Array.isArray(rawResult.emails)) {
            rawResult.emails.forEach(e => {
                const email = typeof e === 'string' ? e : e.email;
                if (email) allEmails.add(email.toLowerCase());
            });
        }
        
        return {
            status: this.determineStatus(finalContacts, rawResult),
            contacts: finalContacts,
            emails: Array.from(allEmails),
            extracted_links: rawResult.extracted_links || [],
            http_code: rawResult.http_code || null,
            meta: {
                source: this.name,
                raw_contacts: rawContacts.length,
                valid_contacts: validationResult.valid.length,
                invalid_contacts: validationResult.invalid.length,
                validation_stats: validationResult.stats,
                hallucination_stats: filterStats
            }
        };
    }
    
    /**
     * Extract evidence from contact/result
     * @param {Object} contact - Contact object
     * @param {Object} rawResult - Raw miner result
     * @returns {Object|null}
     */
    extractEvidence(contact, rawResult) {
        // If contact already has evidence
        if (contact.evidence) {
            return contact.evidence;
        }
        
        // Try to extract from raw data
        if (contact.raw) {
            // Check for mailto link
            if (typeof contact.raw === 'string' && contact.raw.includes('mailto:')) {
                return createEvidence(EVIDENCE_TYPES.MAILTO_LINK, {
                    href: `mailto:${contact.email}`,
                    foundIn: 'raw_html'
                });
            }
        }
        
        // For non-AI miners, assume text match evidence
        if (this.name !== 'aiMiner' && contact.email) {
            return createEvidence(EVIDENCE_TYPES.TEXT_MATCH, {
                pattern: 'email_regex',
                text: contact.email
            });
        }
        
        return null;
    }
    
    /**
     * Determine final status
     * @param {Array} contacts - Final contacts
     * @param {Object} rawResult - Raw result
     * @returns {string}
     */
    determineStatus(contacts, rawResult) {
        // Preserve blocked/error status
        if (rawResult.status === 'BLOCKED') return 'BLOCKED';
        if (rawResult.status === 'ERROR') return 'ERROR';
        if (rawResult.status === 'DEAD') return 'DEAD';
        
        // Determine by contacts
        if (contacts.length > 0) return 'SUCCESS';
        if (rawResult.emails?.length > 0) return 'PARTIAL';
        if (rawResult.extracted_links?.length > 0) return 'PARTIAL';
        
        return 'PARTIAL';
    }
    
    /**
     * Detect error status from exception
     * @param {Error} err 
     * @returns {string}
     */
    detectErrorStatus(err) {
        if (!err || !err.message) return 'ERROR';
        
        const message = err.message.toUpperCase();
        
        if (message.includes('BLOCK') || message.includes('403') || message.includes('CAPTCHA')) {
            return 'BLOCKED';
        }
        
        if (message.includes('404') || message.includes('NOT FOUND') || message.includes('DEAD')) {
            return 'DEAD';
        }
        
        if (message.includes('TIMEOUT')) {
            return 'TIMEOUT';
        }
        
        return 'ERROR';
    }
    
    /**
     * Get adapter stats
     * @returns {Object}
     */
    getStats() {
        return {
            ...this.stats,
            name: this.name,
            capabilities: this.capabilities,
            successRate: this.stats.totalCalls > 0 
                ? Math.round((this.stats.successCalls / this.stats.totalCalls) * 100) 
                : 0
        };
    }
    
    /**
     * Reset stats
     */
    resetStats() {
        this.stats = {
            totalCalls: 0,
            successCalls: 0,
            failedCalls: 0,
            totalCost: 0,
            totalContacts: 0,
            lastCallAt: null
        };
    }
}

// ============================================
// ADAPTER FACTORY
// ============================================

/**
 * Create adapter for a miner
 * @param {string} name - Miner name
 * @param {Function} minerFn - Original miner function
 * @param {Object} options - Options
 * @returns {BaseMinerAdapter}
 */
function createMinerAdapter(name, minerFn, options = {}) {
    return new BaseMinerAdapter(name, minerFn, options);
}

/**
 * Wrap existing miner with adapter
 * @param {Object} miner - Miner object with name and mine function
 * @returns {BaseMinerAdapter}
 */
function wrapMiner(miner) {
    if (!miner || !miner.name || !miner.mine) {
        throw new Error('Invalid miner object: must have name and mine function');
    }
    
    return createMinerAdapter(miner.name, miner.mine);
}

module.exports = {
    BaseMinerAdapter,
    createMinerAdapter,
    wrapMiner,
    MINER_CAPABILITIES
};
