/**
 * Quality Checker
 * Evaluates extraction quality and decides if retry is needed
 */

// Minimum thresholds
const THRESHOLDS = {
    MIN_CONTACTS: 1,           // At least 1 contact
    MIN_QUALITY_SCORE: 40,     // Minimum overall quality
    MIN_FIELD_COVERAGE: 30,    // % of fields filled
    RETRY_SCORE: 25,           // Below this, try another miner
};

// Field weights for scoring
const FIELD_WEIGHTS = {
    email: 30,      // Required, high weight
    name: 20,       // Very important
    company: 15,    // Important
    phone: 15,      // Important
    country: 5,     // Nice to have
    website: 5,     // Nice to have
    city: 3,        // Optional
    title: 3,       // Optional
    address: 2,     // Optional
};

/**
 * Check quality of extracted contacts
 * @param {Array} contacts - Array of validated contacts
 * @param {Object} extractionStats - Stats from extraction
 * @returns {{score: number, decision: string, details: Object}}
 */
function checkQuality(contacts, extractionStats = {}) {
    console.log(`   [QualityChecker] Evaluating ${contacts.length} contacts`);

    if (!contacts || contacts.length === 0) {
        return {
            score: 0,
            decision: 'FAILED',
            details: {
                reason: 'No contacts extracted',
                recommendation: 'Try different extraction method'
            }
        };
    }

    // Calculate scores
    const contactScores = contacts.map(c => scoreContact(c));
    const avgContactScore = contactScores.reduce((a, b) => a + b, 0) / contactScores.length;
    
    // Field coverage analysis
    const fieldCoverage = analyzeFieldCoverage(contacts);
    
    // Calculate overall score
    const overallScore = calculateOverallScore({
        avgContactScore,
        fieldCoverage,
        contactCount: contacts.length,
        extractionStats
    });

    // Make decision
    const decision = makeDecision(overallScore, contactScores, fieldCoverage);

    const result = {
        score: Math.round(overallScore),
        decision: decision.status,
        details: {
            avgContactScore: Math.round(avgContactScore),
            fieldCoverage,
            contactCount: contacts.length,
            contactScores: {
                min: Math.round(Math.min(...contactScores)),
                max: Math.round(Math.max(...contactScores)),
                avg: Math.round(avgContactScore)
            },
            recommendation: decision.recommendation
        }
    };

    console.log(`   [QualityChecker] Score: ${result.score}/100, Decision: ${decision.status}`);

    return result;
}

/**
 * Score a single contact
 * @param {Object} contact - Contact object
 * @returns {number} - Score 0-100
 */
function scoreContact(contact) {
    if (!contact) return 0;
    
    let score = 0;
    let maxScore = 0;
    
    for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
        maxScore += weight;
        
        const value = contact[field];
        
        if (value && String(value).trim()) {
            // Field has value
            score += weight;
            
            // Bonus for quality values
            const qualityBonus = getFieldQualityBonus(field, value);
            score += qualityBonus;
        }
    }
    
    // Normalize to 0-100
    return Math.min(100, (score / maxScore) * 100);
}

/**
 * Get bonus points for field quality
 */
function getFieldQualityBonus(field, value) {
    if (!value) return 0;
    
    const str = String(value).trim();
    let bonus = 0;
    
    switch (field) {
        case 'name':
            // Bonus for full name (has space)
            if (str.includes(' ') && str.length >= 5) bonus += 5;
            break;
            
        case 'company':
            // Bonus for company with legal suffix
            if (/\b(ltd|inc|corp|llc|gmbh|ag)\b/i.test(str)) bonus += 3;
            break;
            
        case 'phone':
            // Bonus for international format
            if (str.startsWith('+')) bonus += 3;
            break;
            
        case 'website':
            // Bonus for proper URL
            if (str.startsWith('https://')) bonus += 2;
            break;
    }
    
    return bonus;
}

/**
 * Analyze field coverage across all contacts
 */
function analyzeFieldCoverage(contacts) {
    const coverage = {};
    
    for (const field of Object.keys(FIELD_WEIGHTS)) {
        const filled = contacts.filter(c => c[field] && String(c[field]).trim()).length;
        coverage[field] = {
            count: filled,
            percentage: Math.round((filled / contacts.length) * 100)
        };
    }
    
    // Overall coverage
    const totalFields = Object.keys(FIELD_WEIGHTS).length;
    const avgCoverage = Object.values(coverage).reduce((a, b) => a + b.percentage, 0) / totalFields;
    
    return {
        ...coverage,
        overall: Math.round(avgCoverage)
    };
}

/**
 * Calculate overall quality score
 */
function calculateOverallScore({ avgContactScore, fieldCoverage, contactCount, extractionStats }) {
    let score = 0;
    
    // Contact score contributes 50%
    score += avgContactScore * 0.5;
    
    // Field coverage contributes 30%
    score += fieldCoverage.overall * 0.3;
    
    // Contact count bonus (up to 20%)
    const countBonus = Math.min(20, contactCount * 2);
    score += countBonus;
    
    return Math.min(100, score);
}

/**
 * Make quality decision
 */
function makeDecision(overallScore, contactScores, fieldCoverage) {
    // Excellent quality
    if (overallScore >= 80) {
        return {
            status: 'EXCELLENT',
            recommendation: 'Results are high quality, no action needed'
        };
    }
    
    // Good quality
    if (overallScore >= 60) {
        return {
            status: 'GOOD',
            recommendation: 'Results are acceptable'
        };
    }
    
    // Fair quality
    if (overallScore >= THRESHOLDS.MIN_QUALITY_SCORE) {
        const issues = [];
        
        if (fieldCoverage.name.percentage < 50) {
            issues.push('Low name coverage');
        }
        if (fieldCoverage.company.percentage < 50) {
            issues.push('Low company coverage');
        }
        if (fieldCoverage.phone.percentage < 30) {
            issues.push('Low phone coverage');
        }
        
        return {
            status: 'FAIR',
            recommendation: issues.length > 0 
                ? `Consider manual review: ${issues.join(', ')}`
                : 'Results are usable but could be better'
        };
    }
    
    // Poor quality - might retry
    if (overallScore >= THRESHOLDS.RETRY_SCORE) {
        return {
            status: 'POOR',
            recommendation: 'Results may need manual enrichment'
        };
    }
    
    // Very poor - should retry with different method
    return {
        status: 'RETRY',
        recommendation: 'Quality too low, try different extraction method'
    };
}

/**
 * Check if results should trigger retry
 */
function shouldRetry(qualityResult) {
    return qualityResult.decision === 'RETRY' || qualityResult.score < THRESHOLDS.RETRY_SCORE;
}

/**
 * Generate quality report
 */
function generateReport(contacts, qualityResult) {
    return {
        summary: {
            totalContacts: contacts.length,
            qualityScore: qualityResult.score,
            decision: qualityResult.decision
        },
        fieldCoverage: qualityResult.details.fieldCoverage,
        contactScores: qualityResult.details.contactScores,
        recommendation: qualityResult.details.recommendation,
        timestamp: new Date().toISOString()
    };
}

module.exports = {
    checkQuality,
    scoreContact,
    analyzeFieldCoverage,
    shouldRetry,
    generateReport,
    THRESHOLDS,
    FIELD_WEIGHTS,
};
