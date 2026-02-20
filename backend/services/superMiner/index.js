/**
 * SuperMiner v3.2 - Main Entry Point
 *
 * Intelligent mining orchestration system.
 * Orchestrator is always active (SUPERMINER_ENABLED flag removed in Step 2).
 *
 * KURALLAR:
 * - Mevcut miner'lar DEĞİŞMEZ, sadece wrapper pattern
 */

// Version info
const VERSION = '3.2.0';
const BUILD_DATE = '2026-02-week8';

// Check required env variables
function checkRequirements() {
    const issues = [];
    // Redis is now optional — SuperMiner works without it (aggregateSimple fallback)
    return issues;
}

// Log startup info
function logStartup() {
    console.log('\n' + '='.repeat(60));
    console.log(`SuperMiner v${VERSION} (${BUILD_DATE})`);
    console.log('='.repeat(60));
    console.log(`Status: ✅ ACTIVE`);
    console.log(`Redis: ${process.env.REDIS_URL ? '✅ Configured' : '⚠️ Not configured (fallback mode)'}`);

    const issues = checkRequirements();
    if (issues.length > 0) {
        console.log('\n⚠️ Configuration Issues:');
        issues.forEach(issue => console.log(`   - ${issue}`));
    }

    console.log('='.repeat(60) + '\n');
}

// Exports
let eventBus = null;
let intermediateStorage = null;
let UnifiedContact = null;

// Lazy load modules
function getEventBus() {
    if (!eventBus) {
        const { getEventBus: getEB } = require('./services/eventBus');
        eventBus = getEB();
    }
    return eventBus;
}

function getIntermediateStorage() {
    if (!intermediateStorage) {
        const { getIntermediateStorage: getIS } = require('./services/intermediateStorage');
        intermediateStorage = getIS();
    }
    return intermediateStorage;
}

function getUnifiedContactClass() {
    if (!UnifiedContact) {
        const { UnifiedContact: UC } = require('./types/UnifiedContact');
        UnifiedContact = UC;
    }
    
    return UnifiedContact;
}

/**
 * Initialize SuperMiner
 * Call this from server.js at startup
 */
async function initialize() {
    logStartup();

    const issues = checkRequirements();
    if (issues.length > 0) {
        console.error('[SuperMiner] ❌ Cannot initialize due to configuration issues');
        return { success: false, mode: 'error', issues };
    }

    try {
        // Connect to Redis (optional — non-fatal if unavailable)
        const eb = getEventBus();
        const is = getIntermediateStorage();

        if (eb && eb.enabled) {
            try {
                await eb.connect();
            } catch (redisErr) {
                console.warn('[SuperMiner] ⚠️ EventBus Redis connection failed (non-fatal):', redisErr.message);
            }
        }

        if (is && is.enabled) {
            try {
                await is.connect();
            } catch (redisErr) {
                console.warn('[SuperMiner] ⚠️ IntermediateStorage Redis connection failed (non-fatal):', redisErr.message);
            }
        }

        console.log('[SuperMiner] ✅ Initialized successfully');
        if (!process.env.REDIS_URL) {
            console.log('[SuperMiner] ⚠️ Running without Redis — Flow2 disabled, aggregateSimple fallback active');
        }

        return { success: true, mode: 'superminer' };

    } catch (err) {
        console.error('[SuperMiner] ⚠️ Initialization warning:', err.message);
        console.log('[SuperMiner] Continuing without full Redis support');
        return { success: true, mode: 'superminer-degraded' };
    }
}

/**
 * Graceful shutdown
 */
async function shutdown() {
    console.log('[SuperMiner] Shutting down...');
    
    try {
        if (eventBus) {
            await eventBus.disconnect();
        }
        
        if (intermediateStorage) {
            await intermediateStorage.disconnect();
        }
        
        console.log('[SuperMiner] ✅ Shutdown complete');
        
    } catch (err) {
        console.error('[SuperMiner] Shutdown error:', err.message);
    }
}

/**
 * Health check
 */
async function healthCheck() {
    const result = {
        version: VERSION,
        mode: 'superminer'
    };

    const eb = getEventBus();
    const is = getIntermediateStorage();

    if (eb) {
        result.eventBus = await eb.healthCheck();
    }

    if (is) {
        result.intermediateStorage = await is.healthCheck();
    }

    return result;
}

/**
 * Check if SuperMiner should handle a job
 * @param {Object} job - Mining job
 * @returns {boolean}
 */
function shouldUseSuperminer(job) {
    // All jobs use SuperMiner orchestrator
    return true;
}

/**
 * Convert legacy miner result to UnifiedContact array
 * @param {Object} result - Legacy ScrapeResult
 * @param {string} source - Miner source name
 * @returns {Array<UnifiedContact>}
 */
function convertToUnifiedContacts(result, source) {
    const UC = getUnifiedContactClass();
    
    if (!result || !result.contacts || !Array.isArray(result.contacts)) {
        return [];
    }
    
    return result.contacts
        .map(contact => UC.fromLegacy(contact, source))
        .filter(c => c.isValid());
}

// Lazy load pipeline modules
let pipeline = null;
function getPipeline() {
    if (!pipeline) {
        pipeline = require('./pipeline');
    }
    return pipeline;
}

// Lazy load adapter modules
let adapters = null;
function getAdapters() {
    if (!adapters) {
        adapters = require('./adapters');
    }
    return adapters;
}

// Lazy load services modules
let services = null;
function getServices() {
    if (!services) {
        services = require('./services');
    }
    return services;
}

// Get cost tracker
let costTracker = null;
function getCostTracker() {
    if (!costTracker) {
        const { getCostTracker: getCT } = require('./services/costTracker');
        costTracker = getCT();
    }
    return costTracker;
}

// Get HTML cache
let htmlCache = null;
function getHtmlCache() {
    if (!htmlCache) {
        const { getHtmlCache: getHC } = require('./services/htmlCache');
        htmlCache = getHC();
    }
    return htmlCache;
}

// Get page analyzer (Scout)
let pageAnalyzer = null;
function getPageAnalyzer() {
    if (!pageAnalyzer) {
        const { getPageAnalyzer: getPA } = require('./services/pageAnalyzer');
        pageAnalyzer = getPA();
    }
    return pageAnalyzer;
}

// Get smart router
let smartRouter = null;
function getSmartRouter() {
    if (!smartRouter) {
        const { getSmartRouter: getSR } = require('./services/smartRouter');
        smartRouter = getSR();
    }
    return smartRouter;
}

// Get circuit breaker
let circuitBreaker = null;
function getCircuitBreaker() {
    if (!circuitBreaker) {
        const { getCircuitBreaker: getCB } = require('./services/circuitBreaker');
        circuitBreaker = getCB();
    }
    return circuitBreaker;
}

// Create result aggregator (needs db connection)
function createResultAggregator(db) {
    const { createResultAggregator: create } = require('./services/resultAggregator');
    return create(db);
}

// Get SuperMiner Entry (main entry point)
function getEntry() {
    return require('./services/superMinerEntry');
}

// Initialize SuperMiner (convenience wrapper)
async function initializeSuperMiner(db, config = {}) {
    const entry = getEntry();
    return entry.initialize(db, config);
}

// Run mining job (convenience wrapper)
async function runMiningJob(job, db) {
    const entry = getEntry();
    return entry.runMiningJob(job, db);
}

/**
 * Create miner adapter (wrapper for existing miners)
 * @param {string} name - Miner name
 * @param {Function} minerFn - Original mine function
 * @returns {Object} Adapter instance
 */
function createMinerAdapter(name, minerFn) {
    const { createMinerAdapter: create } = getAdapters();
    return create(name, minerFn);
}

/**
 * Validate contacts using ValidatorV2
 * @param {Array} contacts - Contacts to validate
 * @returns {Object} Validation result
 */
function validateContacts(contacts) {
    const { validateContacts: validate } = getPipeline();
    return validate(contacts);
}

/**
 * Filter hallucinations from AI results
 * @param {Array} contacts - Contacts to filter
 * @param {Object} options - Filter options
 * @returns {Object} Filter result
 */
function filterHallucinations(contacts, options = {}) {
    const { filterHallucinations: filter } = getPipeline();
    return filter(contacts, options);
}

module.exports = {
    // Config
    VERSION,
    
    // Lifecycle
    initialize,
    shutdown,
    healthCheck,
    
    // Getters
    getEventBus,
    getIntermediateStorage,
    getUnifiedContactClass,
    getPipeline,
    getAdapters,
    getServices,
    getCostTracker,
    getHtmlCache,
    getPageAnalyzer,
    getSmartRouter,
    getCircuitBreaker,
    getEntry,
    
    // Factories
    createMinerAdapter,
    createResultAggregator,
    
    // Week 6: Main Entry Points
    initializeSuperMiner,
    runMiningJob,
    
    // Helpers
    shouldUseSuperminer,
    convertToUnifiedContacts,
    checkRequirements,
    
    // Week 2: Pipeline
    validateContacts,
    filterHallucinations
};
