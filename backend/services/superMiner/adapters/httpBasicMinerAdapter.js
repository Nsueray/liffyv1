/**
 * httpBasicMinerAdapter.js - SuperMiner v3.1
 * 
 * Adapter for existing HTTP Basic Miner (urlMiner.js)
 * 
 * KURALLAR:
 * - Mevcut urlMiner.js DEĞİŞMEZ
 * - Cache KULLANIR (useCache: true)
 * - Cost: Negligible ($0.0001)
 * - En hızlı miner, ilk denenir
 */

const { BaseMinerAdapter } = require('./baseMinerAdapter');
const { getCostTracker, OPERATION_COSTS } = require('../services/costTracker');

/**
 * Create HTTP Basic Miner Adapter
 * @param {Object} urlMinerModule - The existing urlMiner module
 * @returns {BaseMinerAdapter}
 */
function createHttpBasicMinerAdapter(urlMinerModule) {
    if (!urlMinerModule || !urlMinerModule.runUrlMiningJob) {
        console.warn('[HttpBasicMinerAdapter] urlMiner module not provided or invalid');
        return null;
    }
    
    // Wrapper function that matches expected interface
    const minerFn = async (job) => {
        const costTracker = getCostTracker();
        
        // Record cost
        const costCheck = costTracker.recordCost(
            job.id, 
            'HTTP_REQUEST', 
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
            // Call original miner
            const result = await urlMinerModule.runUrlMiningJob(job.id, job.organizer_id);
            
            // Record success
            costTracker.recordSuccess(job.input);
            
            // Normalize result
            return {
                status: (result.total_emails_raw || 0) > 0 ? 'SUCCESS' : 'PARTIAL',
                emails: [],
                contacts: [],
                extracted_links: [],
                http_code: 200,
                meta: {
                    source: 'httpBasicMiner',
                    total_emails: result.total_emails_raw || 0,
                    total_found: result.total_found || 0
                }
            };
            
        } catch (err) {
            // Record failure
            costTracker.recordFailure(job.input, err.message);
            
            throw err;
        }
    };
    
    return new BaseMinerAdapter('httpBasicMiner', minerFn, {
        description: 'HTTP Basic Miner - Fast axios-based extraction',
        priority: 1,  // Highest priority (try first)
        timeout: 30000
    });
}

module.exports = {
    createHttpBasicMinerAdapter
};
