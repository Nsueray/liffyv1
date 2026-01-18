/**
 * playwrightMinerAdapter.js - SuperMiner v3.1
 * 
 * Adapter for existing Playwright Miners (playwrightTableMiner, miningWorker)
 * 
 * KURALLAR:
 * - Mevcut playwright miner'lar DEĞİŞMEZ
 * - ASLA cache kullanmaz (useCache: false) - HER ZAMAN FRESH FETCH
 * - Cost: $0.001 per page (compute)
 * - Dynamic content, JS rendering için kullanılır
 */

const { BaseMinerAdapter } = require('./baseMinerAdapter');
const { getCostTracker } = require('../services/costTracker');

/**
 * Create Playwright Table Miner Adapter
 * @param {Object} tableMinerModule - The existing playwrightTableMiner module
 * @returns {BaseMinerAdapter}
 */
function createPlaywrightTableMinerAdapter(tableMinerModule) {
    if (!tableMinerModule || !tableMinerModule.mine) {
        console.warn('[PlaywrightTableMinerAdapter] tableMiner module not provided or invalid');
        return null;
    }
    
    const minerFn = async (job) => {
        const costTracker = getCostTracker();
        
        // Record cost
        const costCheck = costTracker.recordCost(
            job.id,
            'PLAYWRIGHT_PAGE',
            job.input
        );
        
        if (!costCheck.allowed) {
            return {
                status: 'COST_LIMIT',
                emails: [],
                contacts: [],
                meta: { error: costCheck.reason }
            };
        }
        
        try {
            // Call original miner - ALWAYS FRESH (no cache)
            const result = await tableMinerModule.mine(job);
            
            // Record success
            costTracker.recordSuccess(job.input);
            
            return result;
            
        } catch (err) {
            costTracker.recordFailure(job.input, err.message);
            throw err;
        }
    };
    
    const adapter = new BaseMinerAdapter('playwrightTableMiner', minerFn, {
        description: 'Playwright Table Miner - Single page table/list extraction',
        priority: 2,
        timeout: 60000
    });
    
    // Override: Playwright NEVER uses cache
    adapter.shouldUseCache = () => false;
    
    return adapter;
}

/**
 * Create Playwright Detail Miner Adapter
 * @param {Object} miningWorkerModule - The existing miningWorker module
 * @returns {BaseMinerAdapter}
 */
function createPlaywrightDetailMinerAdapter(miningWorkerModule) {
    if (!miningWorkerModule || !miningWorkerModule.runMiningTest) {
        console.warn('[PlaywrightDetailMinerAdapter] miningWorker module not provided or invalid');
        return null;
    }
    
    const minerFn = async (job) => {
        const costTracker = getCostTracker();
        
        // Estimate pages (config or default)
        const estimatedPages = job.config?.max_pages || 10;
        
        // Check cost before proceeding
        const canProceed = costTracker.canProceed(
            job.id,
            'PLAYWRIGHT_PAGE',
            job.input
        );
        
        if (!canProceed.allowed) {
            return {
                status: 'COST_LIMIT',
                emails: [],
                contacts: [],
                meta: { error: canProceed.reason }
            };
        }
        
        try {
            // Call original miner - ALWAYS FRESH (no cache)
            await miningWorkerModule.runMiningTest(job);
            
            // Record cost for estimated pages
            for (let i = 0; i < estimatedPages; i++) {
                costTracker.recordCost(job.id, 'PLAYWRIGHT_PAGE', job.input);
            }
            
            // Record success
            costTracker.recordSuccess(job.input);
            
            // Note: This miner saves directly to DB, so we return minimal result
            return {
                status: 'SUCCESS',
                emails: [],
                contacts: [],
                meta: {
                    source: 'playwrightDetailMiner',
                    note: 'Results saved directly to DB'
                }
            };
            
        } catch (err) {
            costTracker.recordFailure(job.input, err.message);
            
            if (err.message?.includes('BLOCK_DETECTED')) {
                return {
                    status: 'BLOCKED',
                    emails: [],
                    contacts: [],
                    meta: { error: 'BLOCKED' }
                };
            }
            
            throw err;
        }
    };
    
    const adapter = new BaseMinerAdapter('playwrightMiner', minerFn, {
        description: 'Playwright Detail Miner - Multi-page crawling with pagination',
        priority: 3,
        timeout: 300000  // 5 minutes for multi-page
    });
    
    // Override: Playwright NEVER uses cache
    adapter.shouldUseCache = () => false;
    
    return adapter;
}

module.exports = {
    createPlaywrightTableMinerAdapter,
    createPlaywrightDetailMinerAdapter
};
