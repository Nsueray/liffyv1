/**
 * orchestratorListener.js - SuperMiner v3.1
 * 
 * Event listener - Redis SUBSCRIBE ile async Flow 2 tetikleme.
 * Standalone worker olarak çalışabilir.
 * 
 * KURALLAR:
 * - Idempotent: Aynı event'i iki kez işlemez
 * - Graceful shutdown destegi
 * - Auto-reconnect
 */

const { getEventBus, CHANNELS } = require('./eventBus');
const { createFlowOrchestrator } = require('./flowOrchestrator');
const { getIntermediateStorage } = require('./intermediateStorage');

// Listener states
const LISTENER_STATE = {
    STOPPED: 'stopped',
    STARTING: 'starting',
    RUNNING: 'running',
    STOPPING: 'stopping'
};

class OrchestratorListener {
    constructor(db, config = {}) {
        this.db = db;
        this.config = {
            enableFlow2Listener: true,
            maxConcurrentFlow2: 2,
            ...config
        };
        
        this.state = LISTENER_STATE.STOPPED;
        this.eventBus = getEventBus();
        this.storage = getIntermediateStorage();
        
        // Flow 2 orchestrator (lazy)
        this.orchestrator = null;
        
        // Active Flow 2 jobs
        this.activeFlow2Jobs = new Set();
        
        // Processed events (idempotency)
        this.processedEvents = new Set();
        
        console.log('[OrchestratorListener] ✅ Initialized');
    }
    
    /**
     * Start listening for events
     */
    async start() {
        if (this.state !== LISTENER_STATE.STOPPED) {
            console.warn('[OrchestratorListener] Already started or starting');
            return false;
        }
        
        this.state = LISTENER_STATE.STARTING;
        
        console.log('[OrchestratorListener] Starting...');
        
        try {
            // Connect event bus
            if (this.eventBus) {
                await this.eventBus.connect();
                
                // Subscribe to aggregation done events
                if (this.config.enableFlow2Listener) {
                    this.eventBus.subscribe(CHANNELS.AGGREGATION_DONE, 
                        (data) => this.handleAggregationDone(data));
                }
                
                // Subscribe to job failed events (for cleanup)
                this.eventBus.subscribe(CHANNELS.JOB_FAILED,
                    (data) => this.handleJobFailed(data));
                
                // Start listening
                await this.eventBus.startListening();
            }
            
            this.state = LISTENER_STATE.RUNNING;
            
            console.log('[OrchestratorListener] ✅ Running');
            
            return true;
            
        } catch (err) {
            console.error('[OrchestratorListener] Start failed:', err.message);
            this.state = LISTENER_STATE.STOPPED;
            return false;
        }
    }
    
    /**
     * Stop listening
     */
    async stop() {
        if (this.state !== LISTENER_STATE.RUNNING) {
            return;
        }
        
        this.state = LISTENER_STATE.STOPPING;
        
        console.log('[OrchestratorListener] Stopping...');
        
        // Wait for active Flow 2 jobs to complete (with timeout)
        const timeout = 60000; // 1 minute
        const startWait = Date.now();
        
        while (this.activeFlow2Jobs.size > 0 && Date.now() - startWait < timeout) {
            console.log(`[OrchestratorListener] Waiting for ${this.activeFlow2Jobs.size} active jobs...`);
            await new Promise(r => setTimeout(r, 5000));
        }
        
        if (this.eventBus) {
            await this.eventBus.disconnect();
        }
        
        this.state = LISTENER_STATE.STOPPED;
        
        console.log('[OrchestratorListener] ✅ Stopped');
    }
    
    /**
     * Handle AGGREGATION_DONE event
     * Decides whether to trigger Flow 2
     */
    async handleAggregationDone(data) {
        const { jobId, enrichmentRate, contactCount, websiteUrls, deepCrawlAttempted } = data;
        
        console.log(`[OrchestratorListener] Received AGGREGATION_DONE for job ${jobId}`);
        console.log(`[OrchestratorListener] Enrichment: ${(enrichmentRate * 100).toFixed(1)}%, Contacts: ${contactCount}`);
        
        // Idempotency check
        const eventKey = `aggregation:${jobId}`;
        if (this.processedEvents.has(eventKey)) {
            console.log(`[OrchestratorListener] Already processed, skipping`);
            return;
        }
        this.processedEvents.add(eventKey);
        
        // Cleanup old processed events
        if (this.processedEvents.size > 1000) {
            const toDelete = Array.from(this.processedEvents).slice(0, 500);
            toDelete.forEach(k => this.processedEvents.delete(k));
        }
        
        // Check if Flow 2 already attempted
        if (deepCrawlAttempted) {
            console.log(`[OrchestratorListener] Deep crawl already attempted, skipping Flow 2`);
            await this.finalizeWithoutFlow2(jobId);
            return;
        }
        
        // Check enrichment threshold
        const threshold = 0.2; // 20%
        if (enrichmentRate >= threshold) {
            console.log(`[OrchestratorListener] Enrichment OK (>= ${threshold * 100}%), no Flow 2 needed`);
            await this.finalizeWithoutFlow2(jobId);
            return;
        }
        
        // Check if websites available
        if (!websiteUrls || websiteUrls.length === 0) {
            console.log(`[OrchestratorListener] No website URLs, skipping Flow 2`);
            await this.finalizeWithoutFlow2(jobId);
            return;
        }
        
        // Check concurrent limit
        if (this.activeFlow2Jobs.size >= this.config.maxConcurrentFlow2) {
            console.log(`[OrchestratorListener] Max concurrent Flow 2 reached, queuing`);
            // In production, this would go to a queue
            // For now, just wait a bit and try again
            setTimeout(() => this.triggerFlow2(jobId, websiteUrls), 10000);
            return;
        }
        
        // Trigger Flow 2
        await this.triggerFlow2(jobId, websiteUrls);
    }
    
    /**
     * Trigger Flow 2 for a job
     */
    async triggerFlow2(jobId, websiteUrls) {
        console.log(`[OrchestratorListener] Triggering Flow 2 for job ${jobId}`);
        console.log(`[OrchestratorListener] Websites to scrape: ${websiteUrls.length}`);
        
        this.activeFlow2Jobs.add(jobId);
        
        try {
            // Get job from DB
            const jobResult = await this.db.query(
                'SELECT * FROM mining_jobs WHERE id = $1',
                [jobId]
            );
            
            if (jobResult.rows.length === 0) {
                console.error(`[OrchestratorListener] Job ${jobId} not found`);
                return;
            }
            
            const job = jobResult.rows[0];
            
            // Create orchestrator if needed
            if (!this.orchestrator) {
                this.orchestrator = createFlowOrchestrator(this.db);
            }
            
            // Execute Flow 2 only
            const flow1Result = {
                contactCount: 0,
                enrichmentRate: 0,
                websiteUrls
            };
            
            const result = await this.orchestrator.executeFlow2(job, flow1Result);
            
            console.log(`[OrchestratorListener] Flow 2 complete for job ${jobId}: ${result?.savedCount || 0} saved`);
            
        } catch (err) {
            console.error(`[OrchestratorListener] Flow 2 failed for job ${jobId}:`, err.message);
            
            // Publish failure
            if (this.eventBus) {
                await this.eventBus.publish(CHANNELS.JOB_FAILED, {
                    jobId,
                    error: `Flow 2 failed: ${err.message}`
                });
            }
            
        } finally {
            this.activeFlow2Jobs.delete(jobId);
        }
    }
    
    /**
     * Finalize job without Flow 2 (direct DB write from temp storage)
     */
    async finalizeWithoutFlow2(jobId) {
        console.log(`[OrchestratorListener] Finalizing job ${jobId} without Flow 2`);
        
        try {
            // Create orchestrator if needed
            if (!this.orchestrator) {
                this.orchestrator = createFlowOrchestrator(this.db);
            }
            
            // Get job
            const jobResult = await this.db.query(
                'SELECT * FROM mining_jobs WHERE id = $1',
                [jobId]
            );
            
            if (jobResult.rows.length === 0) {
                return;
            }
            
            const job = jobResult.rows[0];
            
            // Aggregate V2 with empty scraper results (just writes Flow 1 to DB)
            const result = await this.orchestrator.aggregator.aggregateV2([], {
                jobId,
                organizerId: job.organizer_id
            });
            
            console.log(`[OrchestratorListener] Finalized job ${jobId}: ${result?.savedCount || 0} saved`);
            
        } catch (err) {
            console.error(`[OrchestratorListener] Finalize failed for job ${jobId}:`, err.message);
        }
    }
    
    /**
     * Handle JOB_FAILED event (cleanup)
     */
    async handleJobFailed(data) {
        const { jobId, error } = data;
        
        console.log(`[OrchestratorListener] Job ${jobId} failed: ${error}`);
        
        // Remove from active jobs
        this.activeFlow2Jobs.delete(jobId);
        
        // Clear temp storage
        if (this.storage) {
            await this.storage.clearFlowResults(jobId);
        }
    }
    
    /**
     * Get listener status
     */
    getStatus() {
        return {
            state: this.state,
            activeFlow2Jobs: Array.from(this.activeFlow2Jobs),
            processedEventsCount: this.processedEvents.size,
            config: this.config
        };
    }
}

// Factory
function createOrchestratorListener(db, config = {}) {
    return new OrchestratorListener(db, config);
}

module.exports = {
    OrchestratorListener,
    createOrchestratorListener,
    LISTENER_STATE
};
