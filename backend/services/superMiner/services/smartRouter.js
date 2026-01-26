/**
 * smartRouter.js - SuperMiner v3.1
 * 
 * Hangi miner'ı kullanacağına karar verir.
 * Page Analyzer sonuçlarına göre yönlendirme yapar.
 * 
 * KURALLAR:
 * - Scout (PageAnalyzer) sonucuna göre karar
 * - Cost-aware routing (ucuz olanı tercih et)
 * - Fallback chain destegi
 * - useCache flag per miner
 */

const { getPageAnalyzer, PAGE_TYPES } = require('./pageAnalyzer');
const { getCostTracker } = require('./costTracker');
const { MINER_CAPABILITIES } = require('../adapters/baseMinerAdapter');

// Router configuration
const ROUTER_CONFIG = {
    // Miner priority order (lower = higher priority = try first)
    minerPriority: {
        httpBasicMiner: 1,
        playwrightTableMiner: 2,
        playwrightMiner: 3,
        aiMiner: 4,
        websiteScraperMiner: 5,
        documentMiner: 6
    },
    
    // Fallback chains
    fallbackChains: {
        httpBasicMiner: ['playwrightTableMiner', 'aiMiner'],
        playwrightTableMiner: ['playwrightMiner', 'aiMiner'],
        playwrightMiner: ['aiMiner'],
        aiMiner: ['playwrightMiner'],
        websiteScraperMiner: []
    },
    
    // Max fallback attempts
    maxFallbacks: 2
};

class SmartRouter {
    constructor() {
        this.analyzer = getPageAnalyzer();
        this.costTracker = getCostTracker();
        
        // Routing stats
        this.stats = {
            totalRoutes: 0,
            routesByMiner: {},
            fallbacksUsed: 0,
            analysisTime: 0
        };
        
        console.log('[SmartRouter] ✅ Initialized');
    }
    
    /**
     * Route a job to appropriate miner(s)
     * @param {Object} job - Mining job
     * @param {Object} options - Routing options
     * @returns {Promise<Object>} Routing decision
     */
    async route(job, options = {}) {
        const startTime = Date.now();
        
        console.log(`[SmartRouter] Routing job ${job.id}: ${job.input}`);
        
        try {
            // Analyze page first (Scout phase)
            const analysis = await this.analyzer.analyze(job.input, {
                skipCache: options.forceAnalysis
            });
            
            // Get recommendation from analysis
            const recommendation = analysis.recommendation;
            
            // Check cost limits
            const costCheck = this.checkCostLimits(job, recommendation.miner);
            
            if (!costCheck.allowed) {
                console.warn(`[SmartRouter] Cost limit: ${costCheck.reason}`);
                
                // Try to find cheaper alternative
                const cheaperMiner = this.findCheaperMiner(recommendation.miner);
                if (cheaperMiner) {
                    recommendation.miner = cheaperMiner;
                    recommendation.reason = 'Downgraded due to cost limits';
                }
            }
            
            // Build routing decision
            const decision = {
                jobId: job.id,
                url: job.input,
                
                // Primary miner
                primaryMiner: recommendation.miner,
                useCache: this.shouldUseCache(recommendation.miner, recommendation),
                
                // Analysis results
                pageType: analysis.pageType,
                paginationType: analysis.paginationType,
                
                // Fallback chain
                fallbackChain: this.buildFallbackChain(recommendation.miner, job),
                
                // Metadata
                reason: recommendation.reason,
                analysisTime: analysis.analysisTime,
                routingTime: Date.now() - startTime,
                
                // Hints for miner
                hints: this.buildHints(analysis, recommendation)
            };
            
            // Update stats
            this.updateStats(decision);
            
            console.log(`[SmartRouter] Decision: ${decision.primaryMiner} (cache: ${decision.useCache})`);
            
            return decision;
            
        } catch (err) {
            console.error(`[SmartRouter] Error routing job ${job.id}:`, err.message);
            
            // Return safe default
            return {
                jobId: job.id,
                url: job.input,
                primaryMiner: 'aiMiner',
                useCache: true,
                pageType: PAGE_TYPES.UNKNOWN,
                fallbackChain: ['playwrightMiner'],
                reason: `Routing error: ${err.message}`,
                routingTime: Date.now() - startTime,
                hints: {}
            };
        }
    }
    
    /**
     * Determine if cache should be used
     */
    shouldUseCache(minerName, recommendation) {
        // Get miner capabilities
        const capabilities = MINER_CAPABILITIES[minerName];
        
        if (!capabilities) {
            return false;
        }
        
        // Playwright NEVER uses cache
        if (minerName.includes('playwright')) {
            return false;
        }
        
        // WebsiteScraper NEVER uses cache
        if (minerName === 'websiteScraperMiner') {
            return false;
        }
        
        // Respect recommendation if explicitly set
        if (recommendation && recommendation.useCache !== undefined) {
            // But still enforce Playwright rule
            if (minerName.includes('playwright')) {
                return false;
            }
            return recommendation.useCache;
        }
        
        return capabilities.useCache;
    }
    
    /**
     * Check cost limits for miner
     */
    checkCostLimits(job, minerName) {
        if (!this.costTracker) {
            return { allowed: true, reason: null };
        }
        
        const capabilities = MINER_CAPABILITIES[minerName] || {};
        const estimatedCost = capabilities.costPerRequest || 0;
        
        return this.costTracker.canProceed(job.id, 'estimate', job.input);
    }
    
    /**
     * Find cheaper miner alternative
     */
    findCheaperMiner(currentMiner) {
        const currentPriority = ROUTER_CONFIG.minerPriority[currentMiner] || 99;
        
        // Find miners with higher priority (lower number = cheaper)
        const cheaper = Object.entries(ROUTER_CONFIG.minerPriority)
            .filter(([miner, priority]) => priority < currentPriority)
            .sort((a, b) => a[1] - b[1]);
        
        if (cheaper.length > 0) {
            return cheaper[0][0];
        }
        
        return null;
    }
    
    /**
     * Build fallback chain for a miner
     */
    buildFallbackChain(primaryMiner, job) {
        const baseChain = ROUTER_CONFIG.fallbackChains[primaryMiner] || [];
        
        // Limit to max fallbacks
        const chain = baseChain.slice(0, ROUTER_CONFIG.maxFallbacks);
        
        // Filter out miners that would exceed cost
        if (this.costTracker) {
            return chain.filter(miner => {
                const check = this.checkCostLimits(job, miner);
                return check.allowed;
            });
        }
        
        return chain;
    }
    
    /**
     * Build hints for miner execution
     */
    buildHints(analysis, recommendation) {
        const hints = {};
        
        // Pagination hints
        if (analysis.paginationType && analysis.paginationType !== 'none') {
            hints.pagination = {
                type: analysis.paginationType,
                detected: true
            };
        }
        
        // Email count hint
        if (analysis.emailCount) {
            hints.expectedEmails = analysis.emailCount;
        }
        
        // Detail links hint
        if (analysis.detailLinks && analysis.detailLinks.length > 0) {
            hints.detailLinks = analysis.detailLinks;
            hints.detailLinkCount = analysis.detailLinkCount;
        }
        
        // Table hint
        if (analysis.hasTable) {
            hints.hasTable = true;
            hints.tableCount = analysis.tableCount;
        }
        
        // Dynamic content hint
        if (analysis.hasDynamicIndicators) {
            hints.isDynamic = true;
            hints.requiresJs = true;
        }
        
        return hints;
    }
    
    /**
     * Get next miner from fallback chain
     * @param {Object} decision - Current routing decision
     * @param {string} failedMiner - Miner that failed
     * @param {string} failReason - Why it failed
     * @returns {Object|null} Next miner decision or null
     */
    getNextFallback(decision, failedMiner, failReason) {
        const chain = decision.fallbackChain || [];
        
        // Find position of failed miner
        const failedIndex = chain.indexOf(failedMiner);
        
        // Get next in chain
        let nextIndex = 0;
        if (failedMiner === decision.primaryMiner) {
            nextIndex = 0;
        } else if (failedIndex >= 0) {
            nextIndex = failedIndex + 1;
        }
        
        if (nextIndex >= chain.length) {
            console.log(`[SmartRouter] No more fallbacks after ${failedMiner}`);
            return null;
        }
        
        const nextMiner = chain[nextIndex];
        
        console.log(`[SmartRouter] Fallback: ${failedMiner} -> ${nextMiner} (reason: ${failReason})`);
        
        this.stats.fallbacksUsed++;
        
        return {
            ...decision,
            primaryMiner: nextMiner,
            useCache: this.shouldUseCache(nextMiner, {}),
            fallbackFrom: failedMiner,
            fallbackReason: failReason
        };
    }
    
    /**
     * Update routing stats
     */
    updateStats(decision) {
        this.stats.totalRoutes++;
        
        const miner = decision.primaryMiner;
        this.stats.routesByMiner[miner] = (this.stats.routesByMiner[miner] || 0) + 1;
        
        if (decision.analysisTime) {
            this.stats.analysisTime += decision.analysisTime;
        }
    }
    
    /**
     * Get routing stats
     */
    getStats() {
        return {
            ...this.stats,
            avgAnalysisTime: this.stats.totalRoutes > 0 
                ? Math.round(this.stats.analysisTime / this.stats.totalRoutes)
                : 0
        };
    }
    
    /**
     * Force route to specific miner (bypass analysis)
     * @param {Object} job 
     * @param {string} minerName 
     * @returns {Object}
     */
    forceRoute(job, minerName) {
        console.log(`[SmartRouter] Force routing job ${job.id} to ${minerName}`);
        
        return {
            jobId: job.id,
            url: job.input,
            primaryMiner: minerName,
            useCache: this.shouldUseCache(minerName, {}),
            pageType: PAGE_TYPES.UNKNOWN,
            fallbackChain: ROUTER_CONFIG.fallbackChains[minerName] || [],
            reason: 'Force routed by user/config',
            routingTime: 0,
            hints: {},
            forced: true
        };
    }
    
    /**
     * Route based on job config (if specified)
     * @param {Object} job 
     * @returns {Object|null}
     */
    routeFromConfig(job) {
        const config = job.config || {};
        
        // Check for explicit miner preference
        if (config.preferred_miner) {
            return this.forceRoute(job, config.preferred_miner);
        }
        
        // mining_mode is handled by execution plans; SmartRouter does not interpret it.
        
        // No config preference, use smart routing
        return null;
    }
    
    /**
     * Main routing entry point
     * Checks config first, then uses smart analysis
     */
    async routeJob(job, options = {}) {
        // Check config-based routing first
        const configRoute = this.routeFromConfig(job);
        if (configRoute) {
            return configRoute;
        }
        
        // Use smart analysis-based routing
        return this.route(job, options);
    }
}

// Singleton
let instance = null;

function getSmartRouter() {
    if (!instance) {
        instance = new SmartRouter();
    }
    return instance;
}

module.exports = {
    SmartRouter,
    getSmartRouter,
    ROUTER_CONFIG
};
