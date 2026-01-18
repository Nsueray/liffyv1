/**
 * SuperMiner v3.1 - Main Entry Point
 * 
 * Feature flag ile kontrol edilen intelligent mining orchestration system.
 * 
 * KURALLAR:
 * - SUPERMINER_ENABLED=false → %100 legacy davranış
 * - SUPERMINER_ENABLED=true → SuperMiner aktif
 * - Mevcut miner'lar DEĞİŞMEZ, sadece wrapper pattern
 */

// Feature flag
const SUPERMINER_ENABLED = process.env.SUPERMINER_ENABLED === 'true';

// Version info
const VERSION = '3.1.2';
const BUILD_DATE = '2025-01-week3';

// Check required env variables
function checkRequirements() {
    const issues = [];
    
    if (SUPERMINER_ENABLED) {
        if (!process.env.REDIS_URL) {
            issues.push('REDIS_URL is required when SUPERMINER_ENABLED=true');
        }
    }
    
    return issues;
}

// Log startup info
function logStartup() {
    console.log('\n' + '='.repeat(60));
    console.log(`SuperMiner v${VERSION} (${BUILD_DATE})`);
    console.log('='.repeat(60));
    console.log(`Status: ${SUPERMINER_ENABLED ? '✅ ENABLED' : '⚠️ DISABLED (legacy mode)'}`);
    
    if (SUPERMINER_ENABLED) {
        console.log(`Redis: ${process.env.REDIS_URL ? '✅ Configured' : '❌ Missing'}`);
        
        const issues = checkRequirements();
        if (issues.length > 0) {
            console.log('\n⚠️ Configuration Issues:');
            issues.forEach(issue => console.log(`   - ${issue}`));
        }
    }
    
    console.log('='.repeat(60) + '\n');
}

// Exports
let eventBus = null;
let intermediateStorage = null;
let UnifiedContact = null;

// Lazy load modules only when enabled
function getEventBus() {
    if (!SUPERMINER_ENABLED) {
        return null;
    }
    
    if (!eventBus) {
        const { getEventBus: getEB } = require('./services/eventBus');
        eventBus = getEB();
    }
    
    return eventBus;
}

function getIntermediateStorage() {
    if (!SUPERMINER_ENABLED) {
        return null;
    }
    
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
 * Call this from server.js if SUPERMINER_ENABLED
 */
async function initialize() {
    logStartup();
    
    if (!SUPERMINER_ENABLED) {
        console.log('[SuperMiner] Running in legacy mode, no initialization needed');
        return { success: true, mode: 'legacy' };
    }
    
    const issues = checkRequirements();
    if (issues.length > 0) {
        console.error('[SuperMiner] ❌ Cannot initialize due to configuration issues');
        return { success: false, mode: 'error', issues };
    }
    
    try {
        // Connect to Redis
        const eb = getEventBus();
        const is = getIntermediateStorage();
        
        if (eb) {
            await eb.connect();
        }
        
        if (is) {
            await is.connect();
        }
        
        console.log('[SuperMiner] ✅ Initialized successfully');
        
        return { success: true, mode: 'superminer' };
        
    } catch (err) {
        console.error('[SuperMiner] ❌ Initialization failed:', err.message);
        return { success: false, mode: 'error', error: err.message };
    }
}

/**
 * Graceful shutdown
 */
async function shutdown() {
    if (!SUPERMINER_ENABLED) {
        return;
    }
    
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
        enabled: SUPERMINER_ENABLED,
        mode: SUPERMINER_ENABLED ? 'superminer' : 'legacy'
    };
    
    if (SUPERMINER_ENABLED) {
        const eb = getEventBus();
        const is = getIntermediateStorage();
        
        if (eb) {
            result.eventBus = await eb.healthCheck();
        }
        
        if (is) {
            result.intermediateStorage = await is.healthCheck();
        }
    }
    
    return result;
}

/**
 * Check if SuperMiner should handle a job
 * @param {Object} job - Mining job
 * @returns {boolean}
 */
function shouldUseSuperminer(job) {
    if (!SUPERMINER_ENABLED) {
        return false;
    }
    
    // Future: Check job.version === 'v2' or job.config.use_superminer
    // For now, all new jobs use SuperMiner when enabled
    
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
    if (!SUPERMINER_ENABLED) {
        return null;
    }
    
    if (!costTracker) {
        const { getCostTracker: getCT } = require('./services/costTracker');
        costTracker = getCT();
    }
    
    return costTracker;
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
    SUPERMINER_ENABLED,
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
    
    // Helpers
    shouldUseSuperminer,
    convertToUnifiedContacts,
    checkRequirements,
    
    // Week 2: Pipeline & Adapters
    createMinerAdapter,
    validateContacts,
    filterHallucinations
};
