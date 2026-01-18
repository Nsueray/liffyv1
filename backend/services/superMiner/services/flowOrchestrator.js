/**
 * flowOrchestrator.js - SuperMiner v3.1
 * 
 * Ana akış kontrolü - Flow 1 ve Flow 2 yönetimi.
 * BullMQ entegrasyonu için hazır ama şimdilik in-memory.
 * 
 * KURALLAR:
 * - Flow 1: Scout → Router → Miners → Aggregator V1 → Redis
 * - Flow 2: Event trigger → WebsiteScraper → Aggregator V2 → DB
 * - Her job için tek FlowOrchestrator instance
 */

const { getSmartRouter } = require('./smartRouter');
const { getCircuitBreaker } = require('./circuitBreaker');
const { getCostTracker } = require('./costTracker');
const { getHtmlCache } = require('./htmlCache');
const { createResultAggregator, ENRICHMENT_THRESHOLD } = require('./resultAggregator');
const { getEventBus, CHANNELS } = require('./eventBus');
const { getIntermediateStorage } = require('./intermediateStorage');

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
        
        // Miner adapters (lazy loaded)
        this.minerAdapters = null;
        
        // Job tracking
        this.activeJobs = new Map();
        
        console.log('[FlowOrchestrator] ✅ Initialized');
    }
    
    /**
     * Load miner adapters lazily
     */
    async loadMinerAdapters() {
        if (this.minerAdapters) return this.minerAdapters;
        
        try {
            const adapters = require('../adapters');
            
            // Load actual miner modules
            const aiMiner = require('../../urlMiners/aiMiner');
            const playwrightTableMiner = require('../../urlMiners/playwrightTableMiner');
            
            this.minerAdapters = {
                aiMiner: adapters.createAIMinerAdapter(aiMiner),
                playwrightTableMiner: adapters.createPlaywrightTableMinerAdapter(playwrightTableMiner),
                websiteScraperMiner: adapters.createWebsiteScraperMinerAdapter()
            };
            
            console.log('[FlowOrchestrator] Miner adapters loaded');
            return this.minerAdapters;
            
        } catch (err) {
            console.error('[FlowOrchestrator] Failed to load adapters:', err.message);
            return null;
        }
    }
    
    /**
     * Execute complete mining flow for a job
     * @param {Object} job - Mining job from DB
     * @returns {Promise<Object>} Final result
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
            // Update job status in DB
            await this.updateJobStatus(jobId, 'processing');
            
            // ========================================
            // FLOW 1: Main Mining
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
                // No Flow 2 needed, write Flow 1 results directly
                console.log('[FlowOrchestrator] Flow 2 not needed, writing directly to DB');
                
                const directResult = await this.aggregator.aggregateSimple(
                    [{ contacts: flow1Result.contacts || [] }],
                    { jobId, organizerId: job.organizer_id, sourceUrl: job.input }
                );
                
                flow2Result = directResult;
            }
            
            // ========================================
            // FINALIZE
            // ========================================
            this.updateState(jobId, FLOW_STATE.COMPLETED);
            
            const totalTime = Date.now() - startTime;
            
            // Update job as completed
            await this.updateJobStatus(jobId, 'completed', {
                total_found: flow2Result?.savedCount || flow1Result.contactCount,
                total_emails_raw: flow2Result?.savedCount || flow1Result.contactCount
            });
            
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
                    triggered: true,
                    savedCount: flow2Result.savedCount
                } : {
                    triggered: false
                },
                cost: costSummary
            };
            
            console.log(`\n${'='.repeat(60)}`);
            console.log(`[FlowOrchestrator] Job ${jobId} COMPLETED in ${(totalTime/1000).toFixed(1)}s`);
            console.log(`[FlowOrchestrator] Final: ${flow2Result?.savedCount || flow1Result.contactCount} contacts`);
            console.log(`${'='.repeat(60)}\n`);
            
            return finalResult;
            
        } catch (err) {
            console.error(`[FlowOrchestrator] Job ${jobId} FAILED:`, err.message);
            
            this.updateState(jobId, FLOW_STATE.FAILED);
            
            // Update job as failed
            await this.updateJobStatus(jobId, 'failed', {
                error: err.message
            });
            
            // Cleanup
            this.activeJobs.delete(jobId);
            if (this.costTracker) {
                this.costTracker.finalizeJob(jobId);
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
     * Execute Flow 1: Scout → Router → Miners → Aggregator V1
     */
    async executeFlow1(job) {
        const jobId = job.id;
        const minerResults = [];
        
        // Load adapters
        const adapters = await this.loadMinerAdapters();
        if (!adapters) {
            throw new Error('Failed to load miner adapters');
        }
        
        // 1. Route the job
        console.log('[Flow1] Step 1: Routing...');
        const routeDecision = await this.router.routeJob(job);
        
        console.log(`[Flow1] Route decision: ${routeDecision.primaryMiner} (cache: ${routeDecision.useCache})`);
        
        // 2. Check circuit breaker
        if (this.circuitBreaker) {
            const canRequest = this.circuitBreaker.canRequest(job.input);
            if (!canRequest.allowed) {
                console.warn(`[Flow1] Circuit breaker: ${canRequest.reason}`);
                // Try fallback or return empty
            }
        }
        
        // 3. Execute primary miner
        console.log(`[Flow1] Step 2: Executing ${routeDecision.primaryMiner}...`);
        
        const primaryMiner = adapters[routeDecision.primaryMiner];
        if (primaryMiner) {
            try {
                const result = await primaryMiner.mine(job, {
                    useCache: routeDecision.useCache,
                    hints: routeDecision.hints
                });
                
                minerResults.push(result);
                
                console.log(`[Flow1] ${routeDecision.primaryMiner}: ${result.contacts?.length || 0} contacts`);
                
                // Record success
                if (this.circuitBreaker && result.status !== 'BLOCKED') {
                    this.circuitBreaker.recordSuccess(job.input);
                }
                
            } catch (err) {
                console.error(`[Flow1] ${routeDecision.primaryMiner} failed:`, err.message);
                
                // Record failure
                if (this.circuitBreaker) {
                    this.circuitBreaker.recordFailure(job.input, err.message);
                }
                
                // Try fallback
                if (routeDecision.fallbackChain && routeDecision.fallbackChain.length > 0) {
                    console.log(`[Flow1] Trying fallback: ${routeDecision.fallbackChain[0]}`);
                    
                    const fallbackMiner = adapters[routeDecision.fallbackChain[0]];
                    if (fallbackMiner) {
                        try {
                            const fallbackResult = await fallbackMiner.mine(job);
                            minerResults.push(fallbackResult);
                        } catch (fallbackErr) {
                            console.error(`[Flow1] Fallback failed:`, fallbackErr.message);
                        }
                    }
                }
            }
        }
        
        // 4. Aggregate results (V1 - to Redis, NOT DB)
        console.log('[Flow1] Step 3: Aggregating (V1 - temp storage)...');
        
        const aggregationResult = await this.aggregator.aggregateV1(minerResults, {
            jobId,
            organizerId: job.organizer_id,
            sourceUrl: job.input
        });
        
        // Extract contacts for return
        const tempData = await this.storage.getFlowResults(jobId);
        
        return {
            contactCount: aggregationResult.contactCount,
            enrichmentRate: aggregationResult.enrichmentRate,
            websiteUrls: aggregationResult.websiteUrlCount > 0 ? tempData?.websiteUrls : [],
            contacts: tempData?.contacts || [],
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
            
            // Just finalize Flow 1 results
            return this.aggregator.aggregateV2([], {
                jobId,
                organizerId: job.organizer_id
            });
        }
        
        console.log(`[Flow2] Scraping ${websiteUrls.length} websites...`);
        
        // Load adapters
        const adapters = await this.loadMinerAdapters();
        
        // Scrape websites
        const scraperResults = [];
        
        if (adapters && adapters.websiteScraperMiner) {
            const { scrapeMultipleWebsites } = require('../adapters/websiteScraperMinerAdapter');
            
            const results = await scrapeMultipleWebsites(websiteUrls, jobId, {
                maxConcurrent: 3,
                maxPagesPerSite: 3
            });
            
            scraperResults.push(...results.filter(r => r.status === 'SUCCESS'));
            
            console.log(`[Flow2] Scraped ${scraperResults.length} websites successfully`);
        }
        
        // Aggregate V2 (final merge + DB write)
        console.log('[Flow2] Aggregating V2 (final merge + DB write)...');
        
        const finalResult = await this.aggregator.aggregateV2(scraperResults, {
            jobId,
            organizerId: job.organizer_id
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
     * Update job status in database
     */
    async updateJobStatus(jobId, status, extraFields = {}) {
        if (!this.db) return;
        
        try {
            const fields = ['status = $1', 'updated_at = NOW()'];
            const values = [status];
            let paramIndex = 2;
            
            for (const [key, value] of Object.entries(extraFields)) {
                if (key === 'error') {
                    fields.push(`stats = jsonb_set(COALESCE(stats, '{}'), '{error}', $${paramIndex}::jsonb)`);
                    values.push(JSON.stringify(value));
                } else {
                    fields.push(`${key} = $${paramIndex}`);
                    values.push(value);
                }
                paramIndex++;
            }
            
            if (status === 'completed') {
                fields.push('completed_at = NOW()');
            }
            
            values.push(jobId);
            
            await this.db.query(
                `UPDATE mining_jobs SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
                values
            );
            
        } catch (err) {
            console.error(`[FlowOrchestrator] Failed to update job status:`, err.message);
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
