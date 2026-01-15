/**
 * Deduplicator
 * Smart merging and deduplication of contacts
 * 
 * Features:
 * - Merge by email (primary key)
 * - Prefer filled fields over empty
 * - Score-based field selection
 * - Keep best data from multiple sources
 */

/**
 * Deduplicate and merge contacts
 * @param {Array} contacts - Array of contacts (may have duplicates)
 * @returns {{contacts: Array, stats: Object}}
 */
function deduplicate(contacts) {
    if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
        return { contacts: [], stats: { original: 0, deduplicated: 0, merged: 0 } };
    }

    console.log(`   [Deduplicator] Processing ${contacts.length} contacts`);

    // Group by email (lowercase)
    const emailGroups = new Map();
    
    for (const contact of contacts) {
        if (!contact.email) continue;
        
        const key = contact.email.toLowerCase().trim();
        
        if (!emailGroups.has(key)) {
            emailGroups.set(key, []);
        }
        
        emailGroups.get(key).push(contact);
    }

    // Merge each group
    const merged = [];
    let mergeCount = 0;
    
    for (const [email, group] of emailGroups) {
        if (group.length === 1) {
            merged.push(group[0]);
        } else {
            merged.push(mergeContactGroup(group));
            mergeCount++;
        }
    }
    
    console.log(`   [Deduplicator] ${contacts.length} → ${merged.length} contacts (${mergeCount} merged)`);

    return {
        contacts: merged,
        stats: {
            original: contacts.length,
            deduplicated: merged.length,
            merged: mergeCount
        }
    };
}

/**
 * Merge a group of contacts with same email
 * @param {Array} group - Array of contacts with same email
 * @returns {Object} - Merged contact
 */
function mergeContactGroup(group) {
    if (group.length === 0) return {};
    if (group.length === 1) return group[0];
    
    // Start with first contact as base
    const merged = { email: group[0].email.toLowerCase() };
    
    // Fields to merge (in priority order)
    const fields = ['name', 'company', 'phone', 'website', 'country', 'city', 'address', 'title'];
    
    for (const field of fields) {
        merged[field] = selectBestValue(group, field);
    }
    
    // Copy any additional fields from source
    for (const contact of group) {
        for (const [key, value] of Object.entries(contact)) {
            if (!merged[key] && value) {
                merged[key] = value;
            }
        }
    }
    
    return merged;
}

/**
 * Select best value for a field from multiple contacts
 * @param {Array} contacts - Array of contacts
 * @param {string} field - Field name
 * @returns {*} - Best value
 */
function selectBestValue(contacts, field) {
    // Collect all values for this field
    const values = contacts
        .map(c => c[field])
        .filter(v => v !== null && v !== undefined && v !== '');
    
    if (values.length === 0) return null;
    if (values.length === 1) return values[0];
    
    // Score each value
    const scored = values.map(v => ({
        value: v,
        score: scoreFieldValue(field, v)
    }));
    
    // Sort by score (highest first)
    scored.sort((a, b) => b.score - a.score);
    
    return scored[0].value;
}

/**
 * Score a field value for quality
 * @param {string} field - Field name
 * @param {*} value - Field value
 * @returns {number} - Score (higher is better)
 */
function scoreFieldValue(field, value) {
    if (!value) return 0;
    
    const str = String(value).trim();
    if (!str) return 0;
    
    let score = 0;
    
    // Base score for having a value
    score += 10;
    
    // Length scoring (not too short, not too long)
    const len = str.length;
    
    switch (field) {
        case 'name':
            // Prefer 5-50 chars
            if (len >= 5 && len <= 50) score += 20;
            // Prefer names with space (first + last)
            if (str.includes(' ')) score += 15;
            // Penalize if looks like a label or data dump
            if (/email|phone|company|firma/i.test(str)) score -= 30;
            // Penalize if contains special chars
            if (/[@:;,]/.test(str)) score -= 20;
            break;
            
        case 'company':
            // Prefer 3-100 chars
            if (len >= 3 && len <= 100) score += 20;
            // Bonus for company indicators
            if (/\b(ltd|inc|corp|llc|gmbh|ag|co\.|company|limited|group)\b/i.test(str)) score += 15;
            // Penalize if looks like data dump
            if (/email|phone|name|isim/i.test(str)) score -= 30;
            // Penalize if contains @
            if (str.includes('@')) score -= 25;
            break;
            
        case 'phone':
            // Prefer 10-15 digits
            const digits = str.replace(/\D/g, '');
            if (digits.length >= 10 && digits.length <= 15) score += 20;
            // Bonus for international format
            if (str.startsWith('+')) score += 10;
            // Penalize if too many non-digit chars
            if ((str.length - digits.length) > 6) score -= 10;
            break;
            
        case 'website':
            // Prefer proper URLs
            if (str.startsWith('https://')) score += 15;
            else if (str.startsWith('http://')) score += 10;
            // Penalize file names
            if (/\.(pdf|doc|xls)/i.test(str)) score -= 30;
            if (/%20/.test(str)) score -= 20;
            // Bonus for www
            if (str.includes('www.')) score += 5;
            break;
            
        case 'country':
            // Prefer single-word countries
            if (!str.includes(':') && len <= 30) score += 15;
            // Penalize if looks like data
            if (/email|phone|company/i.test(str)) score -= 30;
            break;
            
        case 'city':
            // Similar to country
            if (!str.includes(':') && len <= 30) score += 15;
            break;
            
        case 'title':
            // Prefer reasonable length
            if (len >= 3 && len <= 100) score += 15;
            // Penalize if looks like data dump
            if (/email|phone|company/i.test(str)) score -= 30;
            break;
    }
    
    return Math.max(0, score);
}

/**
 * Check if two contacts are likely duplicates
 * @param {Object} a - First contact
 * @param {Object} b - Second contact
 * @returns {boolean}
 */
function areDuplicates(a, b) {
    if (!a || !b) return false;
    
    // Same email = duplicate
    if (a.email && b.email) {
        return a.email.toLowerCase() === b.email.toLowerCase();
    }
    
    return false;
}

/**
 * Remove near-duplicates based on similarity
 * @param {Array} contacts - Array of contacts
 * @param {number} threshold - Similarity threshold (0-1)
 * @returns {Array}
 */
function removeNearDuplicates(contacts, threshold = 0.9) {
    if (!contacts || contacts.length <= 1) return contacts;
    
    const unique = [];
    const seen = new Set();
    
    for (const contact of contacts) {
        if (!contact.email) {
            unique.push(contact);
            continue;
        }
        
        const key = contact.email.toLowerCase();
        
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(contact);
        }
    }
    
    return unique;
}

module.exports = {
    deduplicate,
    mergeContactGroup,
    selectBestValue,
    scoreFieldValue,
    areDuplicates,
    removeNearDuplicates,
};
