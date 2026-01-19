/**
 * flowOrchestrator.js - SuperMiner v3.1
 * 
 * Ana akış kontrolü - Flow 1 ve Flow 2 yönetimi.
 * 
 * PDF MİMARİSİ:
 * - Flow 1: Scout → Router → Miners → Aggregator V1 → Redis (DB'ye YAZMAZ!)
 * - Event: mining:aggregation:done
 * - Flow 2: WebsiteScraper → Aggregator V2 → DB (tek seferde)
 * 
 * KURALLAR:
 * - Miner'lar sadece sonuç döner, DB'ye yazmaz
 * - Aggregator V1 Redis'e yazar (temp_results:{jobId})
 * - Aggregator V2 DB'ye yazar (final merge)
 */

const { getSmartRouter } = require('./smartRouter');
const { getCircuitBreaker } = require('./circuitBreaker');
const { getCostTracker } = require('./costTracker');
const { getHtmlCache } = require('./htmlCache');
const { createResultAggregator, ENRICHMENT_THRESHOLD } = require('./resultAggregator');
const { getEventBus, CHANNELS } = require('./eventBus');
const { getIntermediateStorage } = require('./intermediateStorage');
const { UnifiedContact } = require('../types/UnifiedContact');

// Flow states
const FLOW_STATE = {
    PENDING: 'pending',
    FLOW1_RUNNING: 'flow1_running',
    FLOW1_COMPLETE: 'flow1_complete',
    FLOW2_RUNNING: 'flow2_running',
    FLOW2_COMPLETE: 'flow2_complete',
    COMPLETED: 'completed',
    FAILED: 'failed'
};

// Default config
const DEFAULT_CONFIG = {
    maxMinersPerJob: 3,
    enableFlow2: true,
    flow2Threshold: ENRICHMENT_THRESHOLD,
    maxFlow2Websites: 20,
    timeoutMs: 300000 // 5 minutes
};

class FlowOrchestrator {
    constructor(db, config = {}) {
        this.db = db;
        this.config = { ...DEFAULT_CONFIG, ...config };
        
        // Services
        this.router = getSmartRouter();
        this.circuitBreaker = getCircuitBreaker();
        this.costTracker = getCostTracker();
        this.htmlCache = getHtmlCache();
        this.eventBus = getEventBus();
        this.storage = getIntermediateStorage();
        
        // Aggregator (needs db)
        this.aggregator = createResultAggregator(db);
        
        // Miner modules (lazy loaded)
        this.miners = null;
        
        // Job tracking
        this.activeJobs = new Map();
        
        console.log('[FlowOrchestrator] ✅ Initialized');
    }
    
    /**
     * Load legacy miner modules
     * These miners return results WITHOUT writing to DB
     */
    async loadMiners() {
        if (this.miners) return this.miners;
        
        try {
            // Load legacy miner modules that return results (don't write to DB)
            const aiMiner = require('../../urlMiners/aiMiner');
            const playwrightTableMiner = require('../../urlMiners/playwrightTableMiner');
            
            this.miners = {
                // Direct miners (return results, don't write to DB)
                aiMiner: {
                    name: 'aiMiner',
                    mine: async (job) => {
                        console.log(`[aiMiner] Starting for: ${job.input}`);
                        const result = await aiMiner.mine(job);
                        return this.normalizeResult(result, 'aiMiner');
                    }
                },
                
                playwrightTableMiner: {
                    name: 'playwrightTableMiner',
                    mine: async (job) => {
                        console.log(`[playwrightTableMiner] Starting for: ${job.input}`);
                        const result = await playwrightTableMiner.mine(job);
                        return this.normalizeResult(result, 'playwrightTableMiner');
                    }
                },
                
                // Composite miner: runs multiple miners and merges
                fullMiner: {
                    name: 'fullMiner',
                    mine: async (job) => {
                        console.log(`[fullMiner] Starting composite mining for: ${job.input}`);
                        
                        const results = [];
                        
                        // Run playwrightTableMiner first (faster)
                        try {
                            const tableResult = await playwrightTableMiner.mine(job);
                            results.push(this.normalizeResult(tableResult, 'playwrightTableMiner'));
                            console.log(`[fullMiner] playwrightTableMiner: ${tableResult?.emails?.length || 0} emails`);
                        } catch (err) {
                            console.warn(`[fullMiner] playwrightTableMiner failed: ${err.message}`);
                        }
                        
                        // Run aiMiner (more comprehensive)
                        try {
                            const aiResult = await aiMiner.mine(job);
                            results.push(this.normalizeResult(aiResult, 'aiMiner'));
                            console.log(`[fullMiner] aiMiner: ${aiResult?.emails?.length || 0} emails`);
                        } catch (err) {
                            console.warn(`[fullMiner] aiMiner failed: ${err.message}`);
                        }
                        
                        // Merge results
                        return this.mergeResults(results);
                    }
                }
            };
            
            // Aliases
            this.miners.playwrightMiner = this.miners.fullMiner;
            this.miners.playwrightDetailMiner = this.miners.fullMiner;
            this.miners.httpBasicMiner = this.miners.playwrightTableMiner;
            
            console.log('[FlowOrchestrator] Miners loaded:', Object.keys(this.miners).join(', '));
            return this.miners;
            
        } catch (err) {
            console.error('[FlowOrchestrator] Failed to load miners:', err.message);
            return null;
        }
    }
    
    /**
     * Normalize miner result to standard format
     */
    normalizeResult(result, source) {
        if (!result) {
            return { status: 'EMPTY', contacts: [], emails: [], source };
        }
        
        const contacts = [];
        
        // Extract emails
        const emails = result.emails || [];
        
        // Convert to UnifiedContact format
        if (result.contacts && Array.isArray(result.contacts)) {
            for (const c of result.contacts) {
                contacts.push(new UnifiedContact({
                    email: c.email || c.emails?.[0],
                    contactName: c.contact_name || c.name,
                    companyName: c.company_name || c.company,
                    jobTitle: c.job_title || c.title,
                    phone: c.phone,
                    website: c.website,
                    country: c.country,
                    city: c.city,
                    address: c.address,
                    source: source,
                    confidence: c.confidence || 50
                }));
            }
        }
        
        // Also create contacts from raw emails (if no contacts)
        if (contacts.length === 0 && emails.length > 0) {
            for (const email of emails) {
                if (typeof email === 'string') {
                    contacts.push(new UnifiedContact({
                        email: email,
                        source: source,
                        confidence: 40
                    }));
                }
            }
        }
        
        return {
            status: contacts.length > 0 ? 'SUCCESS' : 'EMPTY',
            contacts,
            emails,
            source,
            meta: result.meta || {}
        };
    }
    
    /**
     * Merge multiple miner results
     */
    mergeResults(results) {
        const emailMap = new Map();
        let totalEmails = [];
        
        for (const result of results) {
            if (!result || !result.contacts) continue;
            
            totalEmails = totalEmails.concat(result.emails || []);
            
            for (const contact of result.contacts) {
                if (!contact.email) continue;
                
                const key = contact.email.toLowerCase();
                
                if (emailMap.has(key)) {
                    // Merge with existing
                    const existing = emailMap.get(key);
                    emailMap.set(key, UnifiedContact.merge(existing, contact));
                } else {
                    emailMap.set(key, contact);
                }
            }
        }
        
        const contacts = Array.from(emailMap.values());
        
        return {
            status: contacts.length > 0 ? 'SUCCESS' : 'EMPTY',
            contacts,
            emails: [...new Set(totalEmails)],
            source: 'merged'
        };
    }
    
    /**
     * Execute complete mining flow for a job
     * PDF Mimarisi: Flow 1 → (optional) Flow 2 → DB Write
     */
    async executeJob(job) {
        const jobId = job.id;
        const startTime = Date.now();
        
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[FlowOrchestrator] Starting job ${jobId}`);
        console.log(`[FlowOrchestrator] URL: ${job.input}`);
        console.log(`${'='.repeat(60)}\n`);
        
        // Initialize job tracking
        this.activeJobs.set(jobId, {
            state: FLOW_STATE.PENDING,
            startTime,
            job
        });
        
        // Initialize cost tracking
        if (this.costTracker) {
            this.costTracker.initJob(jobId, job.organizer_id);
        }
        
        try {
            // ========================================
            // FLOW 1: Miners → Aggregator V1 → Redis
            // ========================================
            this.updateState(jobId, FLOW_STATE.FLOW1_RUNNING);
            
            const flow1Result = await this.executeFlow1(job);
            
            this.updateState(jobId, FLOW_STATE.FLOW1_COMPLETE);
            
            console.log(`[FlowOrchestrator] Flow 1 complete: ${flow1Result.contactCount} contacts`);
            console.log(`[FlowOrchestrator] Enrichment rate: ${(flow1Result.enrichmentRate * 100).toFixed(1)}%`);
            
            // ========================================
            // FLOW 2: Deep Crawl (if needed)
            // ========================================
            let flow2Result = null;
            
            if (this.shouldTriggerFlow2(flow1Result)) {
                console.log(`[FlowOrchestrator] Triggering Flow 2 (enrichment < ${this.config.flow2Threshold * 100}%)`);
                
                this.updateState(jobId, FLOW_STATE.FLOW2_RUNNING);
                
                flow2Result = await this.executeFlow2(job, flow1Result);
                
                this.updateState(jobId, FLOW_STATE.FLOW2_COMPLETE);
                
                console.log(`[FlowOrchestrator] Flow 2 complete: ${flow2Result?.savedCount || 0} saved`);
            } else {
                // No Flow 2 needed, Aggregator V2 writes Flow 1 results to DB
                console.log('[FlowOrchestrator] Flow 2 not needed, finalizing...');
                
                flow2Result = await this.aggregator.aggregateV2([], {
                    jobId,
                    organizerId: job.organizer_id,
                    sourceUrl: job.input
                });
            }
            
            // ========================================
            // FINALIZE
            // ========================================
            this.updateState(jobId, FLOW_STATE.COMPLETED);
            
            const totalTime = Date.now() - startTime;
            
            // Finalize cost tracking
            let costSummary = null;
            if (this.costTracker) {
                costSummary = this.costTracker.finalizeJob(jobId);
            }
            
            // Cleanup
            this.activeJobs.delete(jobId);
            
            const finalResult = {
                status: 'COMPLETED',
                jobId,
                totalTime,
                flow1: {
                    contactCount: flow1Result.contactCount,
                    enrichmentRate: flow1Result.enrichmentRate
                },
                flow2: flow2Result ? {
                    triggered: flow1Result.enrichmentRate < this.config.flow2Threshold,
                    savedCount: flow2Result.savedCount || flow2Result.stats?.saved || 0
                } : {
                    triggered: false
                },
                cost: costSummary
            };
            
            console.log(`\n${'='.repeat(60)}`);
            console.log(`[FlowOrchestrator] Job ${jobId} COMPLETED in ${(totalTime/1000).toFixed(1)}s`);
            console.log(`[FlowOrchestrator] Final: ${flow2Result?.savedCount || flow2Result?.stats?.saved || flow1Result.contactCount} contacts saved`);
            console.log(`${'='.repeat(60)}\n`);
            
            return finalResult;
            
        } catch (err) {
            console.error(`[FlowOrchestrator] Job ${jobId} FAILED:`, err.message);
            
            this.updateState(jobId, FLOW_STATE.FAILED);
            
            // Cleanup
            this.activeJobs.delete(jobId);
            if (this.costTracker) {
                this.costTracker.finalizeJob(jobId);
            }
            
            // Clear temp storage
            if (this.storage) {
                await this.storage.clearFlowResults(jobId);
            }
            
            // Publish failure event
            if (this.eventBus) {
                await this.eventBus.publish(CHANNELS.JOB_FAILED, {
                    jobId,
                    error: err.message
                });
            }
            
            return {
                status: 'FAILED',
                jobId,
                error: err.message,
                totalTime: Date.now() - startTime
            };
        }
    }
    
    /**
     * Execute Flow 1: Miners → Aggregator V1 → Redis
     * DOES NOT WRITE TO DB!
     */
    async executeFlow1(job) {
        const jobId = job.id;
        
        // Load miners
        const miners = await this.loadMiners();
        if (!miners) {
            throw new Error('Failed to load miners');
        }
        
        // 1. Route the job (determine which miner to use)
        console.log('[Flow1] Step 1: Routing...');
        const routeDecision = await this.router.routeJob(job);
        
        const selectedMiner = routeDecision.primaryMiner;
        console.log(`[Flow1] Route decision: ${selectedMiner}`);
        
        // 2. Check circuit breaker
        if (this.circuitBreaker) {
            const canRequest = this.circuitBreaker.canRequest(job.input);
            if (!canRequest.allowed) {
                console.warn(`[Flow1] Circuit breaker: ${canRequest.reason}`);
                // Continue anyway, might recover
            }
        }
        
        // 3. Execute miner
        console.log(`[Flow1] Step 2: Mining with ${selectedMiner}...`);
        
        const miner = miners[selectedMiner] || miners.fullMiner;
        let minerResult;
        
        try {
            minerResult = await miner.mine(job);
            
            console.log(`[Flow1] Miner result: ${minerResult.contacts?.length || 0} contacts, ${minerResult.emails?.length || 0} emails`);
            
            // Record success in circuit breaker
            if (this.circuitBreaker && minerResult.status !== 'BLOCKED') {
                this.circuitBreaker.recordSuccess(job.input);
            }
            
        } catch (err) {
            console.error(`[Flow1] Miner failed: ${err.message}`);
            
            // Record failure in circuit breaker
            if (this.circuitBreaker) {
                this.circuitBreaker.recordFailure(job.input, err.message);
            }
            
            minerResult = { status: 'FAILED', contacts: [], emails: [], error: err.message };
        }
        
        // 4. Aggregate V1 (save to Redis, NOT DB!)
        console.log('[Flow1] Step 3: Aggregating (V1 → Redis)...');
        
        const aggregationResult = await this.aggregator.aggregateV1(
            [minerResult],
            {
                jobId,
                organizerId: job.organizer_id,
                sourceUrl: job.input
            }
        );
        
        return {
            contactCount: aggregationResult.contactCount,
            enrichmentRate: aggregationResult.enrichmentRate,
            websiteUrls: aggregationResult.websiteUrlCount > 0 ? 
                (await this.storage.getFlowResults(jobId))?.websiteUrls : [],
            minerStats: aggregationResult.minerStats
        };
    }
    
    /**
     * Execute Flow 2: WebsiteScraper → Aggregator V2 → DB
     */
    async executeFlow2(job, flow1Result) {
        const jobId = job.id;
        
        // Get website URLs from Flow 1
        const websiteUrls = (flow1Result.websiteUrls || [])
            .slice(0, this.config.maxFlow2Websites);
        
        if (websiteUrls.length === 0) {
            console.log('[Flow2] No website URLs to scrape');
            
            // Just finalize Flow 1 results to DB
            return this.aggregator.aggregateV2([], {
                jobId,
                organizerId: job.organizer_id,
                sourceUrl: job.input
            });
        }
        
        console.log(`[Flow2] Scraping ${websiteUrls.length} websites...`);
        
        // Scrape websites (simplified for now)
        const scraperResults = [];
        
        // TODO: Implement actual website scraping
        // For now, just finalize Flow 1 results
        
        // Aggregate V2 (final merge + DB write)
        console.log('[Flow2] Aggregating V2 (final merge → DB)...');
        
        const finalResult = await this.aggregator.aggregateV2(scraperResults, {
            jobId,
            organizerId: job.organizer_id,
            sourceUrl: job.input
        });
        
        return finalResult;
    }
    
    /**
     * Check if Flow 2 should be triggered
     */
    shouldTriggerFlow2(flow1Result) {
        if (!this.config.enableFlow2) {
            return false;
        }
        
        // Trigger if enrichment rate is below threshold
        if (flow1Result.enrichmentRate < this.config.flow2Threshold) {
            return true;
        }
        
        // Trigger if we have websites to scrape and few contacts
        if (flow1Result.websiteUrls?.length > 0 && flow1Result.contactCount < 10) {
            return true;
        }
        
        return false;
    }
    
    /**
     * Update job state
     */
    updateState(jobId, state) {
        const jobInfo = this.activeJobs.get(jobId);
        if (jobInfo) {
            jobInfo.state = state;
            jobInfo.stateUpdatedAt = Date.now();
        }
    }
    
    /**
     * Get job state
     */
    getJobState(jobId) {
        return this.activeJobs.get(jobId);
    }
    
    /**
     * Get all active jobs
     */
    getActiveJobs() {
        return Array.from(this.activeJobs.entries()).map(([id, info]) => ({
            jobId: id,
            state: info.state,
            startTime: info.startTime,
            elapsed: Date.now() - info.startTime
        }));
    }
}

// Factory
function createFlowOrchestrator(db, config = {}) {
    return new FlowOrchestrator(db, config);
}

module.exports = {
    FlowOrchestrator,
    createFlowOrchestrator,
    FLOW_STATE,
    DEFAULT_CONFIG
};
