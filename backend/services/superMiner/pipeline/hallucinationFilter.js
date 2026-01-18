/**
 * hallucinationFilter.js - SuperMiner v3.1
 * 
 * AI hallucination prevention through evidence requirement.
 * 
 * KURALLAR:
 * - AI ciktisinda evidence alani zorunlu
 * - Evidence yoksa confidence max 40%
 * - Evidence tipleri: mailto_link, table_cell, text_match, dom_element
 * - Context-aware scoring
 */

const { CONFIDENCE } = require('../types/UnifiedContact');

// ============================================
// EVIDENCE TYPES
// ============================================

const EVIDENCE_TYPES = {
    MAILTO_LINK: 'mailto_link',      // <a href="mailto:...">
    TABLE_CELL: 'table_cell',        // <td>email@...</td>
    TEXT_MATCH: 'text_match',        // Plain text regex match
    DOM_ELEMENT: 'dom_element',      // Specific DOM selector
    META_TAG: 'meta_tag',            // <meta> tag
    SCHEMA_ORG: 'schema_org',        // JSON-LD schema
    VCARD: 'vcard',                  // vCard format
    MICRODATA: 'microdata',          // HTML microdata
    NONE: 'none'                     // No evidence (AI guess)
};

// Evidence reliability scores (0-100)
const EVIDENCE_RELIABILITY = {
    [EVIDENCE_TYPES.MAILTO_LINK]: 95,   // Very reliable
    [EVIDENCE_TYPES.TABLE_CELL]: 85,    // Reliable
    [EVIDENCE_TYPES.SCHEMA_ORG]: 90,    // Very reliable
    [EVIDENCE_TYPES.VCARD]: 90,         // Very reliable
    [EVIDENCE_TYPES.MICRODATA]: 85,     // Reliable
    [EVIDENCE_TYPES.META_TAG]: 80,      // Good
    [EVIDENCE_TYPES.DOM_ELEMENT]: 75,   // Good
    [EVIDENCE_TYPES.TEXT_MATCH]: 60,    // Moderate
    [EVIDENCE_TYPES.NONE]: 30           // Low - likely hallucination
};

// Max confidence when no evidence
const NO_EVIDENCE_MAX_CONFIDENCE = 40;

// ============================================
// EVIDENCE VALIDATION
// ============================================

/**
 * Validate evidence object
 * @param {Object} evidence 
 * @returns {{valid: boolean, type: string, reliability: number, issues: string[]}}
 */
function validateEvidence(evidence) {
    const issues = [];
    
    if (!evidence) {
        return {
            valid: false,
            type: EVIDENCE_TYPES.NONE,
            reliability: EVIDENCE_RELIABILITY[EVIDENCE_TYPES.NONE],
            issues: ['No evidence provided']
        };
    }
    
    // Check evidence type
    const type = evidence.type || EVIDENCE_TYPES.NONE;
    
    if (!Object.values(EVIDENCE_TYPES).includes(type)) {
        issues.push(`Unknown evidence type: ${type}`);
        return {
            valid: false,
            type: EVIDENCE_TYPES.NONE,
            reliability: EVIDENCE_RELIABILITY[EVIDENCE_TYPES.NONE],
            issues
        };
    }
    
    // Type-specific validation
    switch (type) {
        case EVIDENCE_TYPES.MAILTO_LINK:
            if (!evidence.href || !evidence.href.startsWith('mailto:')) {
                issues.push('mailto_link evidence missing valid href');
                return {
                    valid: false,
                    type: EVIDENCE_TYPES.NONE,
                    reliability: EVIDENCE_RELIABILITY[EVIDENCE_TYPES.NONE],
                    issues
                };
            }
            break;
            
        case EVIDENCE_TYPES.TABLE_CELL:
            if (!evidence.selector && !evidence.text) {
                issues.push('table_cell evidence missing selector or text');
            }
            break;
            
        case EVIDENCE_TYPES.DOM_ELEMENT:
            if (!evidence.selector) {
                issues.push('dom_element evidence missing selector');
            }
            break;
            
        case EVIDENCE_TYPES.TEXT_MATCH:
            if (!evidence.pattern && !evidence.text) {
                issues.push('text_match evidence missing pattern or text');
            }
            break;
            
        case EVIDENCE_TYPES.SCHEMA_ORG:
            if (!evidence.schema) {
                issues.push('schema_org evidence missing schema data');
            }
            break;
    }
    
    const reliability = EVIDENCE_RELIABILITY[type] || EVIDENCE_RELIABILITY[EVIDENCE_TYPES.NONE];
    
    return {
        valid: issues.length === 0,
        type,
        reliability,
        issues
    };
}

/**
 * Create evidence object
 * @param {string} type - Evidence type
 * @param {Object} data - Evidence data
 * @returns {Object}
 */
function createEvidence(type, data = {}) {
    return {
        type: type || EVIDENCE_TYPES.NONE,
        ...data,
        createdAt: new Date().toISOString()
    };
}

// ============================================
// CONFIDENCE ADJUSTMENT
// ============================================

/**
 * Adjust confidence based on evidence
 * @param {number} originalConfidence - Original confidence score
 * @param {Object} evidence - Evidence object
 * @param {string} source - Miner source
 * @returns {{confidence: number, adjustment: string, details: Object}}
 */
function adjustConfidenceByEvidence(originalConfidence, evidence, source = 'unknown') {
    const evidenceResult = validateEvidence(evidence);
    
    let adjustedConfidence = originalConfidence;
    let adjustment = 'none';
    
    // AI source without evidence = cap confidence
    if (source === 'aiMiner' && !evidenceResult.valid) {
        if (originalConfidence > NO_EVIDENCE_MAX_CONFIDENCE) {
            adjustedConfidence = NO_EVIDENCE_MAX_CONFIDENCE;
            adjustment = 'capped_no_evidence';
        }
    }
    
    // Good evidence = boost confidence
    if (evidenceResult.valid && evidenceResult.reliability >= 80) {
        const boost = Math.min(20, (evidenceResult.reliability - 70) / 2);
        adjustedConfidence = Math.min(CONFIDENCE.MAX, originalConfidence + boost);
        adjustment = 'boosted_good_evidence';
    }
    
    // Excellent evidence (mailto, schema) = high confidence
    if (evidenceResult.reliability >= 90) {
        adjustedConfidence = Math.max(adjustedConfidence, 85);
        adjustment = 'high_reliability_evidence';
    }
    
    return {
        confidence: Math.round(adjustedConfidence),
        adjustment,
        details: {
            original: originalConfidence,
            adjusted: Math.round(adjustedConfidence),
            evidenceType: evidenceResult.type,
            evidenceReliability: evidenceResult.reliability,
            evidenceValid: evidenceResult.valid,
            issues: evidenceResult.issues
        }
    };
}

// ============================================
// HALLUCINATION DETECTION
// ============================================

/**
 * Detect potential hallucination patterns
 * @param {Object} contact - Contact object
 * @returns {{isHallucination: boolean, confidence: number, reasons: string[]}}
 */
function detectHallucination(contact) {
    const reasons = [];
    let hallucinationScore = 0;
    
    if (!contact) {
        return { isHallucination: true, confidence: 100, reasons: ['No contact'] };
    }
    
    // 1. AI source without evidence
    if (contact.source === 'aiMiner' && !contact.evidence) {
        hallucinationScore += 30;
        reasons.push('AI source without evidence');
    }
    
    // 2. Too perfect data (AI tends to fill all fields)
    const filledFields = [
        contact.email,
        contact.contactName,
        contact.companyName,
        contact.phone,
        contact.website,
        contact.country,
        contact.city,
        contact.address,
        contact.jobTitle
    ].filter(Boolean).length;
    
    if (filledFields >= 8 && contact.source === 'aiMiner') {
        hallucinationScore += 20;
        reasons.push('Suspiciously complete data from AI');
    }
    
    // 3. Generic-looking generated names
    const genericNamePatterns = [
        /^john (doe|smith)$/i,
        /^jane (doe|smith)$/i,
        /^test\s/i,
        /^user\s/i,
        /^contact\s/i,
        /^admin\s/i
    ];
    
    if (contact.contactName && genericNamePatterns.some(p => p.test(contact.contactName))) {
        hallucinationScore += 40;
        reasons.push('Generic/placeholder name detected');
    }
    
    // 4. Email doesn't match company domain
    if (contact.email && contact.website) {
        const emailDomain = contact.email.split('@')[1];
        try {
            const websiteDomain = new URL(contact.website).hostname.replace('www.', '');
            if (emailDomain && websiteDomain && !emailDomain.includes(websiteDomain.split('.')[0])) {
                hallucinationScore += 15;
                reasons.push('Email domain does not match website');
            }
        } catch {
            // Invalid URL, skip check
        }
    }
    
    // 5. Phone looks fake (all same digit, sequential)
    if (contact.phone) {
        const digits = contact.phone.replace(/\D/g, '');
        if (/^(.)\1+$/.test(digits)) {
            hallucinationScore += 50;
            reasons.push('Phone is all same digit');
        }
        if (/^123456|^654321/.test(digits)) {
            hallucinationScore += 50;
            reasons.push('Phone is sequential');
        }
    }
    
    // 6. Country/City mismatch with common knowledge
    const cityCountryMismatches = [
        { city: /^paris$/i, country: /^(?!france)/i },
        { city: /^london$/i, country: /^(?!uk|united kingdom|england)/i },
        { city: /^tokyo$/i, country: /^(?!japan)/i },
        { city: /^new york$/i, country: /^(?!usa|united states|us)/i },
    ];
    
    if (contact.city && contact.country) {
        for (const mismatch of cityCountryMismatches) {
            if (mismatch.city.test(contact.city) && mismatch.country.test(contact.country)) {
                hallucinationScore += 25;
                reasons.push(`City/Country mismatch: ${contact.city} not in ${contact.country}`);
                break;
            }
        }
    }
    
    // Determine if hallucination
    const isHallucination = hallucinationScore >= 50;
    
    return {
        isHallucination,
        confidence: Math.min(100, hallucinationScore),
        reasons
    };
}

// ============================================
// MAIN FILTER FUNCTION
// ============================================

/**
 * Filter contacts for hallucinations and adjust confidence
 * @param {Array} contacts - Array of contacts
 * @param {Object} options - Filter options
 * @returns {{passed: Array, filtered: Array, stats: Object}}
 */
function filterHallucinations(contacts, options = {}) {
    const {
        rejectHallucinations = true,
        minConfidence = 30,
        adjustConfidence = true
    } = options;
    
    const passed = [];
    const filtered = [];
    let totalAdjusted = 0;
    
    for (const contact of contacts) {
        // Detect hallucination
        const hallucinationResult = detectHallucination(contact);
        
        if (hallucinationResult.isHallucination && rejectHallucinations) {
            filtered.push({
                contact,
                reason: 'hallucination',
                details: hallucinationResult
            });
            continue;
        }
        
        // Adjust confidence if needed
        let finalContact = contact;
        
        if (adjustConfidence) {
            const confidenceResult = adjustConfidenceByEvidence(
                contact.confidence || 50,
                contact.evidence,
                contact.source
            );
            
            if (confidenceResult.adjustment !== 'none') {
                totalAdjusted++;
                finalContact = {
                    ...contact,
                    confidence: confidenceResult.confidence,
                    _confidenceAdjustment: confidenceResult.details
                };
            }
        }
        
        // Min confidence check
        if (finalContact.confidence < minConfidence) {
            filtered.push({
                contact: finalContact,
                reason: 'low_confidence',
                details: { confidence: finalContact.confidence, minimum: minConfidence }
            });
            continue;
        }
        
        passed.push(finalContact);
    }
    
    return {
        passed,
        filtered,
        stats: {
            total: contacts.length,
            passed: passed.length,
            filtered: filtered.length,
            confidenceAdjusted: totalAdjusted,
            filterReasons: {
                hallucination: filtered.filter(f => f.reason === 'hallucination').length,
                lowConfidence: filtered.filter(f => f.reason === 'low_confidence').length
            }
        }
    };
}

module.exports = {
    // Main functions
    filterHallucinations,
    detectHallucination,
    adjustConfidenceByEvidence,
    
    // Evidence
    validateEvidence,
    createEvidence,
    EVIDENCE_TYPES,
    EVIDENCE_RELIABILITY,
    
    // Constants
    NO_EVIDENCE_MAX_CONFIDENCE
};
