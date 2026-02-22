/**
 * resultAggregator.js - SuperMiner v3.2
 * 
 * Flow 1 ve Flow 2 sonuçlarını birleştirir.
 * 
 * KURALLAR:
 * - V1: Flow 1 sonunda çağrılır, DB'ye YAZMAZ, Redis'e temp kayıt
 * - V2: Flow 2 sonunda çağrılır, temp + yeni sonuçları birleştirir
 * - Final merge sonrası TEK SEFERDE DB'ye yazılır
 * - Deterministic merge (tie-breaker: higher confidence wins)
 * 
 * CONTACT TYPES:
 * - Email-based: contacts with valid email (priority)
 * - Profile-only: contacts with contactName + sourceUrl but no email (low confidence)
 * 
 * DEDUP RULES:
 * - Email-based: dedup by email.toLowerCase()
 * - Profile-only: dedup by (contactName + sourceUrl) signature
 * - Profile-only NEVER overwrites email-based contacts
 */

const { getIntermediateStorage } = require('./intermediateStorage');
const { getEventBus, CHANNELS } = require('./eventBus');
const { UnifiedContact, createSignature } = require('../types/UnifiedContact');
const { validateContacts } = require('../pipeline/validatorV2');
const { filterHallucinations } = require('../pipeline/hallucinationFilter');

// Canonical aggregation (persons + affiliations)
const { normalizeMinerOutput } = require('../../normalizer');
const aggregationTrigger = require('../../aggregationTrigger');

// Enrichment rate threshold for triggering Flow 2
const ENRICHMENT_THRESHOLD = 0.2; // 20%

// Profile-only contact confidence cap
const PROFILE_ONLY_CONFIDENCE = 25;

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
        
        // Count email-based vs profile-only
        const emailBased = mergedContacts.filter(c => c.email);
        const profileOnly = mergedContacts.filter(c => !c.email);
        
        console.log(`[Aggregator V1] Merged: ${mergedContacts.length} unique contacts`);
        console.log(`[Aggregator V1] → Email-based: ${emailBased.length}`);
        console.log(`[Aggregator V1] → Profile-only: ${profileOnly.length}`);
        
        // Calculate enrichment rate
        const enrichmentRate = this.calculateEnrichmentRate(mergedContacts);
        
        console.log(`[Aggregator V1] Enrichment rate: ${(enrichmentRate * 100).toFixed(1)}%`);
        
        // Extract website URLs for potential Flow 2
        const websiteUrls = this.extractWebsiteUrls(mergedContacts);
        
        console.log(`[Aggregator V1] Found ${websiteUrls.length} website URLs for potential deep crawl`);
        
        // Calculate miner stats
        const minerStats = this.calculateMinerStats(minerResults);

        // Check if Redis storage is available — if not, fallback to direct DB write
        if (!this.storage || !this.storage.enabled) {
            console.log(`[Aggregator V1] Redis unavailable, falling back to direct DB write (aggregateSimple)`);
            const simpleResult = await this.aggregateSimple(minerResults, jobContext);
            return {
                status: 'FLOW1_COMPLETE',
                jobId,
                contactCount: mergedContacts.length,
                emailBasedCount: emailBased.length,
                profileOnlyCount: profileOnly.length,
                enrichmentRate,
                websiteUrlCount: 0,
                needsDeepCrawl: false,
                minerStats,
                _alreadyPersisted: true
            };
        }

        // Save to Redis (NOT to DB!)
        const contactCount = mergedContacts.length;
        const emailBasedCount = emailBased.length;
        const profileOnlyCount = profileOnly.length;
        const websiteUrlCount = websiteUrls.length;

        const saveResult = await this.storage.saveFlowResults(jobId, {
            contacts: mergedContacts.map(c => c.toObject ? c.toObject() : c),
            minerStats,
            websiteUrls,
            enrichmentRate,
            sourceUrl,
            organizerId
        });

        // Memory cleanup — release large arrays after Redis save
        mergedContacts.length = 0;
        emailBased.length = 0;
        profileOnly.length = 0;

        if (!saveResult) {
            console.error(`[Aggregator V1] Failed to save temp results for job ${jobId}`);
            return {
                status: 'STORAGE_ERROR',
                jobId,
                contactCount
            };
        }

        // Publish event for orchestrator
        if (this.eventBus) {
            await this.eventBus.publish(CHANNELS.AGGREGATION_DONE, {
                jobId,
                enrichmentRate,
                contactCount,
                emailBasedCount,
                profileOnlyCount,
                websiteUrls: websiteUrls.slice(0, 50), // Limit for payload size
                deepCrawlAttempted: false
            });
        }

        console.log(`[Aggregator V1] ✅ Completed for job ${jobId}`);

        return {
            status: 'FLOW1_COMPLETE',
            jobId,
            contactCount,
            emailBasedCount,
            profileOnlyCount,
            enrichmentRate,
            websiteUrlCount,
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
        
        // Count email-based vs profile-only
        const emailBased = finalContacts.filter(c => c.email);
        const profileOnly = finalContacts.filter(c => !c.email);
        
        console.log(`[Aggregator V2] Final merged: ${finalContacts.length} contacts`);
        console.log(`[Aggregator V2] → Email-based: ${emailBased.length}`);
        console.log(`[Aggregator V2] → Profile-only: ${profileOnly.length}`);
        
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

        // Canonical aggregation: persons + affiliations
        if (dbResult.savedCount > 0 || dbResult.updatedCount > 0) {
            await this.triggerCanonicalAggregation(contactsWithSource, jobContext);
        }

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
                    savedToDB: dbResult.savedCount,
                    emailBased: dbResult.emailCount,
                    profileOnly: dbResult.profileOnlyCount
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
                saved: dbResult.savedCount,
                emailBased: dbResult.emailCount,
                profileOnly: dbResult.profileOnlyCount
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
        
        // Count types
        const emailBased = mergedContacts.filter(c => c.email);
        const profileOnly = mergedContacts.filter(c => !c.email);
        
        console.log(`[Aggregator Simple] Merged: ${mergedContacts.length} contacts`);
        console.log(`[Aggregator Simple] → Email-based: ${emailBased.length}`);
        console.log(`[Aggregator Simple] → Profile-only: ${profileOnly.length}`);
        
        // Validate
        const validationResult = validateContacts(mergedContacts);
        
        // Filter
        const filterResult = filterHallucinations(validationResult.valid, {
            rejectHallucinations: true,
            minConfidence: 25
        });
        
        // Add sourceUrl
        const contactsWithSource = filterResult.passed.map(contact => ({
            ...contact,
            sourceUrl: contact.sourceUrl || sourceUrl || 'unknown'
        }));
        
        // Write to DB
        const dbResult = await this.writeToDatabase(jobId, organizerId, contactsWithSource);

        // Canonical aggregation: persons + affiliations
        if (dbResult.savedCount > 0 || dbResult.updatedCount > 0) {
            await this.triggerCanonicalAggregation(contactsWithSource, jobContext);
        }

        console.log(`[Aggregator Simple] ✅ Completed: ${dbResult.savedCount} saved`);
        
        return {
            status: 'COMPLETE',
            jobId,
            savedCount: dbResult.savedCount,
            stats: {
                merged: mergedContacts.length,
                validated: validationResult.valid.length,
                filtered: filterResult.passed.length,
                saved: dbResult.savedCount,
                emailBased: dbResult.emailCount,
                profileOnly: dbResult.profileOnlyCount
            }
        };
    }
    
    // ============================================
    // MERGE FUNCTIONS
    // ============================================
    
    /**
     * Merge multiple miner results into unique contacts
     * 
     * DEDUP RULES:
     * - Email-based contacts: dedup by email.toLowerCase()
     * - Profile-only contacts: dedup by (contactName + sourceUrl) signature
     * - Profile-only NEVER overwrites email-based contacts
     */
    mergeResults(minerResults) {
        const emailMap = new Map();       // email -> UnifiedContact
        const profileMap = new Map();     // signature -> UnifiedContact (profile-only)
        
        for (const result of minerResults) {
            if (!result || !result.contacts) continue;
            
            for (const contact of result.contacts) {
                // Convert to UnifiedContact if needed
                const unified = contact instanceof UnifiedContact 
                    ? contact 
                    : new UnifiedContact(contact);
                
                if (unified.email) {
                    // Email-based contact - dedup by email
                    const emailKey = unified.email.toLowerCase();
                    
                    if (emailMap.has(emailKey)) {
                        // Merge with existing (higher confidence wins)
                        const existing = emailMap.get(emailKey);
                        const merged = UnifiedContact.merge(existing, unified);
                        emailMap.set(emailKey, merged);
                    } else {
                        emailMap.set(emailKey, unified);
                    }
                } else if (unified.contactName && unified.sourceUrl) {
                    // Profile-only contact - valid if has name and source
                    const profileKey = this.createProfileSignature(unified.contactName, unified.sourceUrl);
                    
                    // Cap confidence for profile-only contacts
                    unified.confidence = Math.min(unified.confidence || PROFILE_ONLY_CONFIDENCE, PROFILE_ONLY_CONFIDENCE);
                    
                    if (profileMap.has(profileKey)) {
                        // Merge with existing profile-only
                        const existing = profileMap.get(profileKey);
                        const merged = UnifiedContact.merge(existing, unified);
                        merged.confidence = PROFILE_ONLY_CONFIDENCE; // Keep capped
                        profileMap.set(profileKey, merged);
                    } else {
                        profileMap.set(profileKey, unified);
                    }
                }
                // Contacts without email AND without (contactName + sourceUrl) are skipped
            }
        }
        
        // Combine: email-based first, then profile-only
        const allContacts = [
            ...Array.from(emailMap.values()),
            ...Array.from(profileMap.values())
        ];
        
        return allContacts;
    }
    
    /**
     * Merge two contact sets with deduplication
     * Email-based contacts have priority over profile-only
     */
    mergeTwoSets(set1, set2) {
        const emailMap = new Map();
        const profileMap = new Map();
        
        // Helper to process a contact
        const processContact = (contact) => {
            if (contact.email) {
                const emailKey = contact.email.toLowerCase();
                
                if (emailMap.has(emailKey)) {
                    const existing = emailMap.get(emailKey);
                    const merged = UnifiedContact.merge(existing, contact);
                    emailMap.set(emailKey, merged);
                } else {
                    emailMap.set(emailKey, contact);
                }
            } else if (contact.contactName && contact.sourceUrl) {
                const profileKey = this.createProfileSignature(contact.contactName, contact.sourceUrl);
                
                // Cap confidence
                contact.confidence = Math.min(contact.confidence || PROFILE_ONLY_CONFIDENCE, PROFILE_ONLY_CONFIDENCE);
                
                if (profileMap.has(profileKey)) {
                    const existing = profileMap.get(profileKey);
                    const merged = UnifiedContact.merge(existing, contact);
                    merged.confidence = PROFILE_ONLY_CONFIDENCE;
                    profileMap.set(profileKey, merged);
                } else {
                    profileMap.set(profileKey, contact);
                }
            }
        };
        
        // Process set1 first (primary)
        for (const contact of set1) {
            processContact(contact);
        }
        
        // Process set2 (secondary)
        for (const contact of set2) {
            processContact(contact);
        }
        
        // Combine: email-based first, then profile-only
        const allContacts = [
            ...Array.from(emailMap.values()),
            ...Array.from(profileMap.values())
        ];
        
        return allContacts;
    }
    
    /**
     * Create signature for profile-only contact deduplication
     */
    createProfileSignature(contactName, sourceUrl) {
        const normalizedName = (contactName || '').toLowerCase().trim().replace(/\s+/g, ' ');
        const normalizedUrl = (sourceUrl || '').toLowerCase().trim();
        return `profile:${normalizedName}:${normalizedUrl}`;
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
     * 
     * METRICS:
     * - savedCount: total rows saved (new inserts)
     * - emailCount: contacts with email
     * - profileOnlyCount: contacts without email (profile-only)
     */
    async writeToDatabase(jobId, organizerId, contacts) {
        if (!this.db) {
            console.error('[Aggregator] No database connection');
            return { savedCount: 0, emailCount: 0, profileOnlyCount: 0, error: 'No DB' };
        }
        
        const client = await this.db.connect();
        let savedCount = 0;
        let emailCount = 0;
        let profileOnlyCount = 0;
        let updatedCount = 0;
        
        try {
            await client.query('BEGIN');
            
            for (const contact of contacts) {
                const email = contact.email?.toLowerCase() || null;
                const isProfileOnly = !email;
                
                if (isProfileOnly) {
                    // Profile-only contact - needs contactName and sourceUrl
                    if (!contact.contactName || !contact.sourceUrl) {
                        continue; // Skip invalid profile-only contacts
                    }
                    
                    // Check if profile-only already exists
                    const existing = await client.query(
                        `SELECT id FROM mining_results 
                         WHERE job_id = $1 
                         AND contact_name = $2 
                         AND source_url = $3 
                         AND (emails IS NULL OR emails = '{}')`,
                        [jobId, contact.contactName, contact.sourceUrl]
                    );
                    
                    if (existing.rows.length > 0) {
                        // Update existing profile-only
                        await client.query(`
                            UPDATE mining_results SET
                                company_name = COALESCE(NULLIF($1, ''), company_name),
                                job_title = COALESCE(NULLIF($2, ''), job_title),
                                phone = COALESCE(NULLIF($3, ''), phone),
                                country = COALESCE(NULLIF($4, ''), country),
                                city = COALESCE(NULLIF($5, ''), city),
                                website = COALESCE(NULLIF($6, ''), website),
                                address = COALESCE(NULLIF($7, ''), address),
                                confidence_score = LEAST(confidence_score, $8),
                                updated_at = NOW()
                            WHERE id = $9
                        `, [
                            contact.companyName,
                            contact.jobTitle,
                            contact.phone,
                            contact.country,
                            contact.city,
                            contact.website,
                            contact.address,
                            contact.confidence || PROFILE_ONLY_CONFIDENCE,
                            existing.rows[0].id
                        ]);
                        updatedCount++;
                    } else {
                        // Insert new profile-only
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
                            [], // Empty emails array for profile-only
                            contact.confidence || PROFILE_ONLY_CONFIDENCE,
                            JSON.stringify({
                                source: contact.source,
                                evidence: contact.evidence,
                                extractedAt: contact.extractedAt,
                                isProfileOnly: true
                            })
                        ]);
                        savedCount++;
                        profileOnlyCount++;
                    }
                } else {
                    // Email-based contact
                    const existing = await client.query(
                        'SELECT id FROM mining_results WHERE job_id = $1 AND $2 = ANY(emails)',
                        [jobId, email]
                    );
                    
                    if (existing.rows.length > 0) {
                        // Update existing email-based contact
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
                        updatedCount++;
                    } else {
                        // Insert new email-based contact
                        const emailsArray = [email];
                        if (contact.additionalEmails && Array.isArray(contact.additionalEmails)) {
                            for (const addEmail of contact.additionalEmails) {
                                if (addEmail && !emailsArray.includes(addEmail.toLowerCase())) {
                                    emailsArray.push(addEmail.toLowerCase());
                                }
                            }
                        }
                        
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
                            emailsArray,
                            contact.confidence || 50,
                            JSON.stringify({
                                source: contact.source,
                                evidence: contact.evidence,
                                extractedAt: contact.extractedAt
                            })
                        ]);
                        savedCount++;
                        emailCount++;
                    }
                }
            }
            
            // Update job stats
            const totalProcessed = savedCount + updatedCount;
            await client.query(`
                UPDATE mining_jobs SET
                    total_found = $1,
                    total_emails_raw = $2,
                    status = 'completed',
                    completed_at = NOW()
                WHERE id = $3
            `, [totalProcessed, emailCount, jobId]);
            
            await client.query('COMMIT');
            
            console.log(`[Aggregator] DB write: ${savedCount} new (${emailCount} email-based, ${profileOnlyCount} profile-only), ${updatedCount} updated`);

            return {
                savedCount,
                emailCount,
                profileOnlyCount,
                updatedCount,
                error: null
            };

        } catch (err) {
            await client.query('ROLLBACK');
            console.error('[Aggregator] DB write error:', err.message);
            return { savedCount: 0, emailCount: 0, profileOnlyCount: 0, error: err.message };

        } finally {
            client.release();
        }
    }

    /**
     * Trigger canonical aggregation (persons + affiliations).
     * Best-effort — never breaks the main SuperMiner flow.
     *
     * @param {Array} contacts - Saved contacts
     * @param {Object} jobContext - { jobId, organizerId, sourceUrl }
     */
    async triggerCanonicalAggregation(contacts, jobContext) {
        if (process.env.DISABLE_SHADOW_MODE === 'true') {
            return;
        }

        try {
            const emailContacts = contacts.filter(c => c.email);
            if (emailContacts.length === 0) return;

            console.log(`[Aggregator] Triggering canonical aggregation for ${emailContacts.length} contacts`);

            const minerOutput = {
                status: 'success',
                raw: {
                    text: '',
                    html: '',
                    blocks: emailContacts.map(c => ({
                        email: c.email || null,
                        emails: c.email ? [c.email] : [],
                        company_name: c.companyName || c.company_name || null,
                        contact_name: c.contactName || c.contact_name || null,
                        website: c.website || null,
                        country: c.country || null,
                        phone: c.phone || null,
                        text: null,
                        data: c,
                    })),
                    links: [],
                },
                meta: {
                    miner_name: 'superMiner',
                    duration_ms: 0,
                    confidence_hint: null,
                    source_url: jobContext.sourceUrl || null,
                    page_title: null,
                },
            };

            const normalizationResult = normalizeMinerOutput(minerOutput);

            await aggregationTrigger.process({
                jobId: jobContext.jobId,
                organizerId: jobContext.organizerId,
                normalizationResult,
                metadata: {
                    original_contact_count: emailContacts.length,
                    source_url: jobContext.sourceUrl || null,
                    mining_mode: 'superminer',
                },
            });

            console.log(`[Aggregator] Canonical aggregation done: ${normalizationResult.stats.candidates_produced} candidates`);
        } catch (err) {
            // Best-effort — never break the SuperMiner flow
            console.error(`[Aggregator] Canonical aggregation error:`, err.message);
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
    ENRICHMENT_THRESHOLD,
    PROFILE_ONLY_CONFIDENCE
};
