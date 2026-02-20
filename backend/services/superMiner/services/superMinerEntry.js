/**
 * superMinerEntry.js - SuperMiner v3.2
 *
 * TEK ENTRY POINT - Tüm SuperMiner işlemleri buradan başlar.
 * Orchestrator always active (SUPERMINER_ENABLED flag removed in Step 2).
 */

const superMiner = require('../index');
const { createFlowOrchestrator } = require('./flowOrchestrator');
const { createOrchestratorListener } = require('./orchestratorListener');

// Singleton instances
let orchestrator = null;
let listener = null;
let isInitialized = false;

/**
 * Initialize SuperMiner system
 * Call this once at server startup
 * 
 * @param {Object} db - Database pool
 * @param {Object} config - Configuration
 * @returns {Promise<Object>} Init result
 */
async function initialize(db, config = {}) {
    console.log('[SuperMinerEntry] Initializing SuperMiner...');
    
    try {
        // Initialize core SuperMiner (Redis connections etc)
        const coreInit = await superMiner.initialize();
        
        if (!coreInit.success) {
            console.error('[SuperMinerEntry] Core init failed:', coreInit.issues);
            return {
                success: false,
                mode: 'error',
                error: 'Core initialization failed',
                issues: coreInit.issues
            };
        }
        
        // Create orchestrator
        orchestrator = createFlowOrchestrator(db, config);
        
        // Create and start listener (for async Flow 2)
        listener = createOrchestratorListener(db, config);
        
        if (config.enableEventListener !== false) {
            await listener.start();
        }
        
        isInitialized = true;
        
        console.log('[SuperMinerEntry] ✅ SuperMiner initialized');
        console.log(`[SuperMinerEntry] Version: ${superMiner.VERSION}`);
        
        return {
            success: true,
            mode: 'superminer',
            version: superMiner.VERSION
        };
        
    } catch (err) {
        console.error('[SuperMinerEntry] Initialization failed:', err.message);
        return {
            success: false,
            mode: 'error',
            error: err.message
        };
    }
}

/**
 * Shutdown SuperMiner system
 * Call this on server shutdown
 */
async function shutdown() {
    console.log('[SuperMinerEntry] Shutting down...');
    
    try {
        if (listener) {
            await listener.stop();
        }
        
        await superMiner.shutdown();
        
        orchestrator = null;
        listener = null;
        isInitialized = false;
        
        console.log('[SuperMinerEntry] ✅ Shutdown complete');
        
    } catch (err) {
        console.error('[SuperMinerEntry] Shutdown error:', err.message);
    }
}

/**
 * Run a mining job
 * Main entry point for mining
 * 
 * @param {Object} job - Mining job from DB
 * @param {Object} db - Database pool
 * @returns {Promise<Object>} Mining result
 */
async function runMiningJob(job, db) {
    // Check initialization
    if (!isInitialized || !orchestrator) {
        throw new Error('[SuperMinerEntry] Not initialized — call initialize() first');
    }

    console.log(`[SuperMinerEntry] Job ${job.id}: Using SuperMiner orchestrator`);

    // Use SuperMiner orchestrator
    return orchestrator.executeJob(job);
}

/**
 * Quick mining (HTTP only, fastest)
 * 
 * @param {string} url - URL to mine
 * @param {Object} options - Options
 * @returns {Promise<Object>} Quick result
 */
async function quickMine(url, options = {}) {
    // Use page analyzer for quick analysis
    const analyzer = superMiner.getPageAnalyzer();
    if (analyzer) {
        return analyzer.analyze(url, { skipCache: options.fresh });
    }

    return { error: 'Quick mine not available — page analyzer not loaded' };
}

/**
 * Get system health
 */
async function getHealth() {
    const health = {
        initialized: isInitialized,
        version: superMiner.VERSION
    };

    if (isInitialized) {
        const coreHealth = await superMiner.healthCheck();
        health.core = coreHealth;

        if (listener) {
            health.listener = listener.getStatus();
        }

        if (orchestrator) {
            health.activeJobs = orchestrator.getActiveJobs();
        }
    }

    return health;
}

/**
 * Get system stats
 */
function getStats() {
    if (!isInitialized) {
        return { mode: 'not_initialized', stats: null };
    }

    const stats = {
        mode: 'superminer',
        version: superMiner.VERSION
    };
    
    // Router stats
    const router = superMiner.getSmartRouter();
    if (router) {
        stats.router = router.getStats();
    }
    
    // Circuit breaker stats
    const breaker = superMiner.getCircuitBreaker();
    if (breaker) {
        stats.circuitBreaker = breaker.getStats();
    }
    
    // Cost tracker stats
    const costTracker = superMiner.getCostTracker();
    if (costTracker) {
        stats.costTracker = costTracker.getGlobalStats();
    }
    
    // Cache stats
    const cache = superMiner.getHtmlCache();
    if (cache) {
        stats.htmlCache = cache.getStats();
    }
    
    return stats;
}

/**
 * Force a specific miner for testing
 * 
 * @param {Object} job - Mining job
 * @param {string} minerName - Miner to use
 * @param {Object} db - Database pool
 * @returns {Promise<Object>} Result
 */
async function runWithMiner(job, minerName, db) {
    if (!orchestrator) {
        return { error: 'SuperMiner not initialized' };
    }
    
    // Force route to specific miner
    const router = superMiner.getSmartRouter();
    if (router) {
        const forcedDecision = router.forceRoute(job, minerName);
        console.log(`[SuperMinerEntry] Forced route to ${minerName}`);
    }
    
    return orchestrator.executeJob(job);
}

// Export everything
module.exports = {
    // Lifecycle
    initialize,
    shutdown,
    
    // Main entry points
    runMiningJob,
    quickMine,
    runWithMiner,
    
    // Status
    getHealth,
    getStats,
    
    // Direct access (for advanced use)
    getOrchestrator: () => orchestrator,
    getListener: () => listener,
    isInitialized: () => isInitialized,
    
    // Re-export version
    VERSION: superMiner.VERSION
};
