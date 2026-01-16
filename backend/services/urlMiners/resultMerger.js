/**
 * Result Merger
 * Combines results from multiple miners into the richest possible data
 * 
 * Strategy:
 * 1. Collect all results from all miners
 * 2. Group by email (primary key)
 * 3. For each email, take the best value for each field
 * 4. Deduplicate and validate
 */

/**
 * Normalize email for comparison
 */
function normalizeEmail(email) {
    if (!email) return null;
    return email.toLowerCase().trim();
}

/**
 * Pick the best (most informative) string value from multiple options
 */
function pickBestString(values) {
    if (!values || values.length === 0) return null;
    
    // Filter out nulls/undefined/empty
    const valid = values.filter(v => v !== null && v !== undefined && v !== '' && typeof v === 'string');
    if (valid.length === 0) return null;
    
    // Pick the longest (usually most detailed)
    return valid.reduce((best, current) => {
        if (!best) return current;
        return current.length > best.length ? current : best;
    }, null);
}

/**
 * Merge multiple miner results into unified contacts
 * @param {Array} minerResults - Array of ScrapeResult objects from different miners
 * @returns {Object} - Merged result with enriched contacts
 */
function mergeResults(minerResults) {
    const emailMap = new Map(); // email -> { contact data }
    const allEmails = new Set();
    
    console.log(`[Merger] Merging results from ${minerResults.length} miners`);
    
    // Collect all data from all miners
    for (const result of minerResults) {
        if (!result) continue;
        
        // Add raw emails
        if (Array.isArray(result.emails)) {
            result.emails.forEach(e => {
                const normalized = normalizeEmail(e);
                if (normalized) allEmails.add(normalized);
            });
        }
        
        // Process structured contacts
        if (Array.isArray(result.contacts)) {
            for (const contact of result.contacts) {
                if (!contact.emails || contact.emails.length === 0) continue;
                
                for (const email of contact.emails) {
                    const normalizedEmail = normalizeEmail(email);
                    if (!normalizedEmail) continue;
                    
                    allEmails.add(normalizedEmail);
                    
                    if (!emailMap.has(normalizedEmail)) {
                        emailMap.set(normalizedEmail, {
                            email: normalizedEmail,
                            companyNames: [],
                            phones: [],
                            addresses: [],
                            websites: [],
                            countries: [],
                            contactNames: [],
                            jobTitles: [],
                            sources: [],
                            raw: []
                        });
                    }
                    
                    const existing = emailMap.get(normalizedEmail);
                    
                    // Accumulate all values
                    if (contact.companyName) existing.companyNames.push(contact.companyName);
                    if (contact.company) existing.companyNames.push(contact.company);
                    
                    // Handle phones - can be array or string
                    if (Array.isArray(contact.phones)) {
                        existing.phones.push(...contact.phones);
                    } else if (contact.phone) {
                        existing.phones.push(contact.phone);
                    }
                    
                    if (contact.address) existing.addresses.push(contact.address);
                    if (contact.website) existing.websites.push(contact.website);
                    if (contact.country) existing.countries.push(contact.country);
                    if (contact.contactName) existing.contactNames.push(contact.contactName);
                    if (contact.jobTitle) existing.jobTitles.push(contact.jobTitle);
                    if (contact.raw) existing.raw.push(contact.raw);
                    if (result.meta?.source) existing.sources.push(result.meta.source);
                }
            }
        }
    }
    
    // Also add emails that weren't in structured contacts
    for (const email of allEmails) {
        if (!emailMap.has(email)) {
            emailMap.set(email, {
                email,
                companyNames: [],
                phones: [],
                addresses: [],
                websites: [],
                countries: [],
                contactNames: [],
                jobTitles: [],
                sources: [],
                raw: []
            });
        }
    }
    
    // Now pick best values for each contact
    const mergedContacts = [];
    
    for (const [email, data] of emailMap) {
        // Dedupe phones
        const uniquePhones = [...new Set(data.phones.filter(p => p))].slice(0, 3);
        
        const contact = {
            email: email,
            companyName: pickBestString(data.companyNames),
            phone: uniquePhones.length > 0 ? uniquePhones.join(', ') : null,
            phones: uniquePhones,
            address: pickBestString(data.addresses),
            website: pickBestString(data.websites),
            country: pickBestString(data.countries),
            contactName: pickBestString(data.contactNames),
            jobTitle: pickBestString(data.jobTitles),
            sources: [...new Set(data.sources)],
            raw: data.raw[0] || null
        };
        
        mergedContacts.push(contact);
    }
    
    console.log(`[Merger] Produced ${mergedContacts.length} merged contacts from ${allEmails.size} unique emails`);
    
    // Calculate overall status
    let status = 'PARTIAL';
    if (mergedContacts.length > 0) {
        status = 'SUCCESS';
    }
    
    // Check if any miner was blocked
    const wasBlocked = minerResults.some(r => r?.status === 'BLOCKED');
    
    // Calculate enrichment rate
    const enrichedCount = mergedContacts.filter(c => c.companyName || c.phone || c.website).length;
    const enrichmentRate = mergedContacts.length > 0 ? enrichedCount / mergedContacts.length : 0;
    
    return {
        status: status,
        wasBlocked: wasBlocked,
        emails: Array.from(allEmails),
        contacts: mergedContacts,
        meta: {
            source: 'merger',
            miners_used: minerResults.filter(r => r).length,
            total_emails: allEmails.size,
            total_contacts: mergedContacts.length,
            enriched_contacts: enrichedCount,
            enrichment_rate: Math.round(enrichmentRate * 100) / 100
        }
    };
}

/**
 * Convert merged contacts to mining_results format for DB
 * @param {Object} job - Mining job
 * @param {Array} contacts - Merged contacts
 * @returns {Array} - Results ready for DB insertion
 */
function toDbResults(job, contacts) {
    return contacts.map(contact => ({
        job_id: job.id,
        organizer_id: job.organizer_id,
        source_url: job.input,
        company_name: contact.companyName,
        contact_name: contact.contactName,
        job_title: contact.jobTitle,
        phone: contact.phone,
        country: contact.country,
        website: contact.website,
        emails: [contact.email],
        raw: JSON.stringify({
            ...contact,
            merged_from: contact.sources
        })
    }));
}

module.exports = {
    mergeResults,
    toDbResults,
    pickBestString,
    normalizeEmail
};
