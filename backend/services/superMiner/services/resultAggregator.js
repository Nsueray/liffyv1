/**
 * resultAggregator.js - SuperMiner v3.1
 * 
 * Flow 1 ve Flow 2 sonuçlarını birleştirir.
 * 
 * KURALLAR:
 * - V1: Flow 1 sonunda çağrılır, DB'ye YAZMAZ, Redis'e temp kayıt
 * - V2: Flow 2 sonunda çağrılır, temp + yeni sonuçları birleştirir
 * - Final merge sonrası TEK SEFERDE DB'ye yazılır
 * - Deterministic merge (tie-breaker: higher confidence wins)
 */

const { getIntermediateStorage } = require('./intermediateStorage');
const { getEventBus, CHANNELS } = require('./eventBus');
const { UnifiedContact, createSignature } = require('../types/UnifiedContact');
const { validateContacts } = require('../pipeline/validatorV2');
const { filterHallucinations } = require('../pipeline/hallucinationFilter');

// Enrichment rate threshold for triggering Flow 2
const ENRICHMENT_THRESHOLD = 0.2; // 20%

class ResultAggregator {
    constructor(db) {
        this.db = db;
        this.storage = getIntermediateStorage();
        this.eventBus = getEventBus();
        
        console.log('[ResultAggregator] ✅ Initialized');
    }
    
    /**
     * Aggregator V1 - Flow 1 sonunda çağrılır
     * DB'ye YAZMAZ, sadece Redis'e temp kayıt yapar
     * 
     * @param {Array} minerResults - Miner sonuçları
     * @param {Object} jobContext - Job bilgileri
     * @returns {Object} Aggregation result
     */
    async aggregateV1(minerResults, jobContext) {
        const { jobId, organizerId, sourceUrl } = jobContext;
        
        console.log(`[Aggregator V1] Starting for job ${jobId}`);
        console.log(`[Aggregator V1] Processing ${minerResults.length} miner results`);
        
        // Merge all miner results
        const mergedContacts = this.mergeResults(minerResults);
        
        console.log(`[Aggregator V1] Merged: ${mergedContacts.length} unique contacts`);
        
        // Calculate enrichment rate
        const enrichmentRate = this.calculateEnrichmentRate(mergedContacts);
        
        console.log(`[Aggregator V1] Enrichment rate: ${(enrichmentRate * 100).toFixed(1)}%`);
        
        // Extract website URLs for potential Flow 2
        const websiteUrls = this.extractWebsiteUrls(mergedContacts);
        
        console.log(`[Aggregator V1] Found ${websiteUrls.length} website URLs for potential deep crawl`);
        
        // Calculate miner stats
        const minerStats = this.calculateMinerStats(minerResults);
        
        // Save to Redis (NOT to DB!)
        const saveResult = await this.storage.saveFlowResults(jobId, {
            contacts: mergedContacts.map(c => c.toObject ? c.toObject() : c),
            minerStats,
            websiteUrls,
            enrichmentRate,
            sourceUrl,
            organizerId
        });
        
        if (!saveResult) {
            console.error(`[Aggregator V1] Failed to save temp results for job ${jobId}`);
            return {
                status: 'STORAGE_ERROR',
                jobId,
                contactCount: mergedContacts.length
            };
        }
        
        // Publish event for orchestrator
        if (this.eventBus) {
            await this.eventBus.publish(CHANNELS.AGGREGATION_DONE, {
                jobId,
                enrichmentRate,
                contactCount: mergedContacts.length,
                websiteUrls: websiteUrls.slice(0, 50), // Limit for payload size
                deepCrawlAttempted: false
            });
        }
        
        console.log(`[Aggregator V1] ✅ Completed for job ${jobId}`);
        
        return {
            status: 'FLOW1_COMPLETE',
            jobId,
            contactCount: mergedContacts.length,
            enrichmentRate,
            websiteUrlCount: websiteUrls.length,
            needsDeepCrawl: enrichmentRate < ENRICHMENT_THRESHOLD,
            minerStats
        };
    }
    
    /**
     * Aggregator V2 - Flow 2 sonunda çağrılır
     * Temp results + scraper results birleştirir, DB'ye yazar
     * 
     * @param {Array} scraperResults - Website scraper sonuçları
     * @param {Object} jobContext - Job bilgileri
     * @returns {Object} Final aggregation result
     */
    async aggregateV2(scraperResults, jobContext) {
        const { jobId, organizerId } = jobContext;
        
        console.log(`[Aggregator V2] Starting final merge for job ${jobId}`);
        
        // Get Flow 1 results from Redis
        const flow1Data = await this.storage.getFlowResults(jobId);
        
        if (!flow1Data) {
            console.error(`[Aggregator V2] Flow 1 results not found for job ${jobId}`);
            return {
                status: 'FLOW1_NOT_FOUND',
                jobId,
                error: 'Flow 1 results expired or missing'
            };
        }
        
        console.log(`[Aggregator V2] Retrieved Flow 1: ${flow1Data.contacts?.length || 0} contacts`);
        console.log(`[Aggregator V2] Scraper results: ${scraperResults.length} sources`);
        
        // Convert Flow 1 contacts back to UnifiedContact
        const flow1Contacts = (flow1Data.contacts || []).map(c => new UnifiedContact(c));
        
        // Merge scraper results
        const scraperContacts = this.mergeResults(scraperResults);
        
        console.log(`[Aggregator V2] Scraper contacts: ${scraperContacts.length}`);
        
        // Final merge: Flow 1 + Scraper
        const finalContacts = this.mergeTwoSets(flow1Contacts, scraperContacts);
        
        console.log(`[Aggregator V2] Final merged: ${finalContacts.length} contacts`);
        
        // Validate final contacts
        const validationResult = validateContacts(finalContacts);
        
        console.log(`[Aggregator V2] Validation: ${validationResult.valid.length} valid, ${validationResult.invalid.length} invalid`);
        
        // Filter hallucinations
        const filterResult = filterHallucinations(validationResult.valid, {
            rejectHallucinations: true,
            minConfidence: 25
        });
        
        console.log(`[Aggregator V2] After filter: ${filterResult.passed.length} passed`);
        
        // Add sourceUrl to each contact (required by DB)
        const contactsWithSource = filterResult.passed.map(contact => ({
            ...contact,
            sourceUrl: contact.sourceUrl || jobContext.sourceUrl || flow1Data.sourceUrl || 'unknown'
        }));
        
        // Write to DB (single transaction)
        const dbResult = await this.writeToDatabase(jobId, organizerId, contactsWithSource);
        
        // Clear temp storage
        await this.storage.clearFlowResults(jobId);
        
        // Publish completion event
        if (this.eventBus) {
            await this.eventBus.publish(CHANNELS.JOB_COMPLETED, {
                jobId,
                totalContacts: dbResult.savedCount,
                totalEmails: dbResult.emailCount,
                stats: {
                    flow1Contacts: flow1Data.contacts?.length || 0,
                    scraperContacts: scraperContacts.length,
                    finalContacts: filterResult.passed.length,
                    savedToDB: dbResult.savedCount
                }
            });
        }
        
        console.log(`[Aggregator V2] ✅ Completed for job ${jobId}: ${dbResult.savedCount} saved`);
        
        return {
            status: 'FLOW2_COMPLETE',
            jobId,
            totalContacts: filterResult.passed.length,
            savedCount: dbResult.savedCount,
            stats: {
                flow1: flow1Data.contacts?.length || 0,
                scraper: scraperContacts.length,
                merged: finalContacts.length,
                validated: validationResult.valid.length,
                filtered: filterResult.passed.length,
                saved: dbResult.savedCount
            }
        };
    }
    
    /**
     * Simple aggregation (no Flow 2, direct DB write)
     * For jobs that don't need deep crawl
     */
    async aggregateSimple(minerResults, jobContext) {
        const { jobId, organizerId, sourceUrl } = jobContext;
        
        console.log(`[Aggregator Simple] Starting for job ${jobId}`);
        
        // Merge results
        const mergedContacts = this.mergeResults(minerResults);
        
        // Validate
        const validationResult = validateContacts(mergedContacts);
        
        // Filter
        const filterResult = filterHallucinations(validationResult.valid, {
            rejectHallucinations: true,
            minConfidence: 25
        });
        
        // Write to DB
        const dbResult = await this.writeToDatabase(jobId, organizerId, filterResult.passed);
        
        console.log(`[Aggregator Simple] ✅ Completed: ${dbResult.savedCount} saved`);
        
        return {
            status: 'COMPLETE',
            jobId,
            savedCount: dbResult.savedCount,
            stats: {
                merged: mergedContacts.length,
                validated: validationResult.valid.length,
                filtered: filterResult.passed.length,
                saved: dbResult.savedCount
            }
        };
    }
    
    // ============================================
    // MERGE FUNCTIONS
    // ============================================
    
    /**
     * Merge multiple miner results into unique contacts
     */
    mergeResults(minerResults) {
        const contactMap = new Map(); // signature -> UnifiedContact
        
        for (const result of minerResults) {
            if (!result || !result.contacts) continue;
            
            for (const contact of result.contacts) {
                // Convert to UnifiedContact if needed
                const unified = contact instanceof UnifiedContact 
                    ? contact 
                    : new UnifiedContact(contact);
                
                // Support email-less profiles when strong signals exist (name + profile URL).
                const signature = createSignature(unified);
                if (!signature) continue;
                
                if (contactMap.has(signature)) {
                    // Merge with existing
                    const existing = contactMap.get(signature);
                    const merged = UnifiedContact.merge(existing, unified);
                    contactMap.set(signature, merged);
                } else {
                    contactMap.set(signature, unified);
                }
            }
        }
        
        return Array.from(contactMap.values());
    }
    
    /**
     * Merge two contact sets with deduplication
     */
    mergeTwoSets(set1, set2) {
        const contactMap = new Map();
        
        // Add set1 (primary)
        for (const contact of set1) {
            const sig = createSignature(contact);
            if (!sig) continue;
            contactMap.set(sig, contact);
        }
        
        // Merge set2
        for (const contact of set2) {
            const sig = createSignature(contact);
            if (!sig) continue;
            
            if (contactMap.has(sig)) {
                const existing = contactMap.get(sig);
                const merged = UnifiedContact.merge(existing, contact);
                contactMap.set(sig, merged);
            } else {
                contactMap.set(sig, contact);
            }
        }
        
        return Array.from(contactMap.values());
    }
    
    // ============================================
    // ENRICHMENT & ANALYSIS
    // ============================================
    
    /**
     * Calculate enrichment rate (how complete are the contacts)
     */
    calculateEnrichmentRate(contacts) {
        if (contacts.length === 0) return 0;
        
        let totalFields = 0;
        let filledFields = 0;
        
        const fieldsToCheck = ['contactName', 'companyName', 'phone', 'website', 'country'];
        
        for (const contact of contacts) {
            for (const field of fieldsToCheck) {
                totalFields++;
                if (contact[field]) {
                    filledFields++;
                }
            }
        }
        
        return totalFields > 0 ? filledFields / totalFields : 0;
    }
    
    /**
     * Extract unique website URLs for deep crawl
     */
    extractWebsiteUrls(contacts) {
        const urls = new Set();
        
        for (const contact of contacts) {
            if (contact.website) {
                try {
                    const url = new URL(contact.website);
                    urls.add(url.origin);
                } catch {
                    // Invalid URL
                }
            }
            
            // Also try to extract from email domain
            if (contact.email) {
                const domain = contact.email.split('@')[1];
                if (domain && !this.isGenericDomain(domain)) {
                    urls.add(`https://${domain}`);
                }
            }
        }
        
        return Array.from(urls);
    }
    
    /**
     * Check if domain is generic email provider
     */
    isGenericDomain(domain) {
        const generic = [
            'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
            'aol.com', 'icloud.com', 'mail.com', 'protonmail.com'
        ];
        return generic.includes(domain.toLowerCase());
    }
    
    /**
     * Calculate stats per miner
     */
    calculateMinerStats(minerResults) {
        const stats = {};
        
        for (const result of minerResults) {
            const source = result.meta?.source || result.meta?.miner || 'unknown';
            
            if (!stats[source]) {
                stats[source] = {
                    contactCount: 0,
                    emailCount: 0,
                    status: result.status
                };
            }
            
            stats[source].contactCount += result.contacts?.length || 0;
            stats[source].emailCount += result.emails?.length || 0;
        }
        
        return stats;
    }
    
    // ============================================
    // DATABASE OPERATIONS
    // ============================================
    
    /**
     * Write contacts to database in single transaction
     */
    async writeToDatabase(jobId, organizerId, contacts) {
        if (!this.db) {
            console.error('[Aggregator] No database connection');
            return { savedCount: 0, emailCount: 0, error: 'No DB' };
        }
        
        const client = await this.db.connect();
        let savedCount = 0;
        let emailCount = 0;
        
        try {
            await client.query('BEGIN');
            
            for (const contact of contacts) {
                const email = contact.email?.toLowerCase();
                const hasEmail = Boolean(email);
                if (!hasEmail && !contact.sourceUrl) {
                    continue;
                }
                
                // Check if exists
                const existing = hasEmail
                    ? await client.query(
                        'SELECT id FROM mining_results WHERE job_id = $1 AND $2 = ANY(emails)',
                        [jobId, email]
                    )
                    : await client.query(
                        'SELECT id, emails FROM mining_results WHERE job_id = $1 AND source_url = $2 LIMIT 1',
                        [jobId, contact.sourceUrl]
                    );
                
                if (existing.rows.length > 0) {
                    if (!hasEmail) {
                        const existingEmails = existing.rows[0]?.emails || [];
                        if (existingEmails.length > 0) {
                            // Email-less contacts must never overwrite email-based records.
                            continue;
                        }
                    }
                    // Update existing
                    if (hasEmail) {
                        await client.query(`
                            UPDATE mining_results SET
                                company_name = COALESCE(NULLIF($1, ''), company_name),
                                contact_name = COALESCE(NULLIF($2, ''), contact_name),
                                job_title = COALESCE(NULLIF($3, ''), job_title),
                                phone = COALESCE(NULLIF($4, ''), phone),
                                country = COALESCE(NULLIF($5, ''), country),
                                city = COALESCE(NULLIF($6, ''), city),
                                website = COALESCE(NULLIF($7, ''), website),
                                address = COALESCE(NULLIF($8, ''), address),
                                confidence_score = GREATEST(confidence_score, $9),
                                updated_at = NOW()
                            WHERE job_id = $10 AND $11 = ANY(emails)
                        `, [
                            contact.companyName,
                            contact.contactName,
                            contact.jobTitle,
                            contact.phone,
                            contact.country,
                            contact.city,
                            contact.website,
                            contact.address,
                            contact.confidence || 50,
                            jobId,
                            email
                        ]);
                    } else {
                        await client.query(`
                            UPDATE mining_results SET
                                company_name = COALESCE(NULLIF($1, ''), company_name),
                                contact_name = COALESCE(NULLIF($2, ''), contact_name),
                                job_title = COALESCE(NULLIF($3, ''), job_title),
                                phone = COALESCE(NULLIF($4, ''), phone),
                                country = COALESCE(NULLIF($5, ''), country),
                                city = COALESCE(NULLIF($6, ''), city),
                                website = COALESCE(NULLIF($7, ''), website),
                                address = COALESCE(NULLIF($8, ''), address),
                                confidence_score = GREATEST(confidence_score, $9),
                                updated_at = NOW()
                            WHERE id = $10
                        `, [
                            contact.companyName,
                            contact.contactName,
                            contact.jobTitle,
                            contact.phone,
                            contact.country,
                            contact.city,
                            contact.website,
                            contact.address,
                            contact.confidence || 50,
                            existing.rows[0].id
                        ]);
                    }
                } else {
                    // Insert new
                    await client.query(`
                        INSERT INTO mining_results 
                        (job_id, organizer_id, source_url, company_name, contact_name, 
                         job_title, phone, country, city, website, address, emails, 
                         confidence_score, raw)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                    `, [
                        jobId,
                        organizerId,
                        contact.sourceUrl,
                        contact.companyName,
                        contact.contactName,
                        contact.jobTitle,
                        contact.phone,
                        contact.country,
                        contact.city,
                        contact.website,
                        contact.address,
                        hasEmail ? [email, ...(contact.additionalEmails || [])] : [],
                        contact.confidence || 50,
                        JSON.stringify({
                            source: contact.source,
                            evidence: contact.evidence,
                            extractedAt: contact.extractedAt
                        })
                    ]);
                    
                    savedCount++;
                }
                
                if (hasEmail) {
                    emailCount++;
                }
            }
            
            // Update job stats
            await client.query(`
                UPDATE mining_jobs SET
                    total_found = $1,
                    total_emails_raw = $2,
                    status = 'completed',
                    completed_at = NOW()
                WHERE id = $3
            `, [savedCount, emailCount, jobId]);
            
            await client.query('COMMIT');
            
            console.log(`[Aggregator] DB write: ${savedCount} new, ${emailCount} total`);
            
            return { savedCount, emailCount, error: null };
            
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('[Aggregator] DB write error:', err.message);
            return { savedCount: 0, emailCount: 0, error: err.message };
            
        } finally {
            client.release();
        }
    }
}

// Factory function
function createResultAggregator(db) {
    return new ResultAggregator(db);
}

module.exports = {
    ResultAggregator,
    createResultAggregator,
    ENRICHMENT_THRESHOLD
};
