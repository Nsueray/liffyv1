@@ -3,50 +3,53 @@
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
 * 
 * v3.1.6 CHANGELOG:
 * - FIX: normalizeResult() now handles both camelCase and snake_case field names
 * - aiMiner returns companyName (camelCase), we now check both formats
 */

const { getSmartRouter } = require('./smartRouter');
const { getCircuitBreaker } = require('./circuitBreaker');
const { getCostTracker } = require('./costTracker');
const { getHtmlCache } = require('./htmlCache');
const { createResultAggregator, ENRICHMENT_THRESHOLD } = require('./resultAggregator');
const { getEventBus, CHANNELS } = require('./eventBus');
const { getIntermediateStorage } = require('./intermediateStorage');
const { getPageAnalyzer, PAGE_TYPES } = require('./pageAnalyzer');
const { buildExecutionPlan } = require('./executionPlanBuilder');
const documentTextNormalizer = require('./documentTextNormalizer');
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
@@ -419,50 +422,160 @@ class FlowOrchestrator {
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
        
        const miningMode = job.config?.mining_mode;
        console.log('[DEBUG][FLOW1] mining_mode =', miningMode);        
        // Full mode: build and run an execution plan when available.
        if (miningMode === 'full' && typeof buildExecutionPlan === 'function') {
            console.log('[Flow1] Full mode: building execution plan...');
            
            const analyzer = getPageAnalyzer();
            let analysis = null;
            
            try {
                analysis = await analyzer.analyze(job.input);
            } catch (err) {
                console.warn(`[Flow1] PageAnalyzer failed: ${err.message}`);
            }
            
            if (analysis) {
                let inputType = 'unknown';
                
                if (analysis.pageType === PAGE_TYPES.DOCUMENT_VIEWER) {
                    inputType = 'document';
                } else if (analysis.pageType === PAGE_TYPES.EXHIBITOR_TABLE || analysis.pageType === 'website') {
                    inputType = 'website';
                }
                
                let executionPlan = [];
                
                try {
                    executionPlan = buildExecutionPlan({ inputType, miningMode: 'full', analysis });
                } catch (err) {
                    console.warn(`[Flow1] Execution plan build failed: ${err.message}`);
                }
                
                const executablePlan = Array.isArray(executionPlan)
                    ? executionPlan.filter((step) => step?.miner && miners[step.miner])
                    : [];
                
                if (executablePlan.length > 0) {
                    console.log(`[Flow1] Execution plan: ${executablePlan.map((step) => step.miner).join(' → ')}`);
                    
                    if (this.circuitBreaker) {
                        const canRequest = this.circuitBreaker.canRequest(job.input);
                        if (!canRequest.allowed) {
                            console.warn(`[Flow1] Circuit breaker: ${canRequest.reason}`);
                        }
                    }
                    
                    const minerResults = [];
                    
                    for (const step of executablePlan) {
                        const miner = miners[step.miner];
                        
                        console.log(`[Flow1] Step 2: Mining with ${step.miner}...`);
                        
                        let minerResult;
                        
                        try {
                            minerResult = await miner.mine(job);
                            
                            console.log(`[Flow1] Miner result: ${minerResult.contacts?.length || 0} contacts, ${minerResult.emails?.length || 0} emails`);
                            
                            if (this.circuitBreaker && minerResult.status !== 'BLOCKED') {
                                this.circuitBreaker.recordSuccess(job.input);
                            }
                        } catch (err) {
                            console.error(`[Flow1] Miner failed: ${err.message}`);
                            
                            if (this.circuitBreaker) {
                                this.circuitBreaker.recordFailure(job.input, err.message);
                            }
                            
                            minerResult = { status: 'FAILED', contacts: [], emails: [], error: err.message };
                        }
                        
                        if (step.normalizer === 'documentTextNormalizer') {
    const normalized = documentTextNormalizer.normalize(minerResult, job.input);

    // contacts (yeni sistem)
    minerResult.contacts = normalized.contacts || [];

    // 🔴 KRİTİK: legacy Aggregator uyumu için
    minerResult.emails = (normalized.contacts || [])
        .map(c => c.email)
        .filter(Boolean);

    if (normalized.stats) {
        minerResult.normalizationStats = normalized.stats;
    }
}
                        
                        console.log(`[Flow1] Executed ${step.miner} (normalizer: ${step.normalizer})`);
                        
                        minerResults.push(minerResult);
                    }
                    
                    console.log('[Flow1] Step 3: Aggregating (V1 → Redis)...');
                    
                    const aggregationResult = await this.aggregator.aggregateV1(
                        minerResults,
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
            }
            
            console.log('[Flow1] Execution plan unavailable, falling back to single miner...');
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
            
