/**
 * aiMinerAdapter.js - SuperMiner v3.1
 * 
 * Adapter for existing AI Miner (Claude-based extraction)
 * 
 * KURALLAR:
 * - Mevcut aiMiner.js DEĞİŞMEZ
 * - HTML Cache KULLANIR (sayfa içeriği için)
 * - Cost: ~$0.01 per AI call (Anthropic API)
 * - En kaliteli sonuç, ama en pahalı
 * - Hallucination filter otomatik uygulanır (BaseMinerAdapter'da)
 */

const { BaseMinerAdapter } = require('./baseMinerAdapter');
const { getCostTracker, OPERATION_COSTS } = require('../services/costTracker');
const { createEvidence, EVIDENCE_TYPES } = require('../pipeline/hallucinationFilter');

/**
 * Create AI Miner Adapter
 * @param {Object} aiMinerModule - The existing aiMiner module
 * @returns {BaseMinerAdapter}
 */
function createAIMinerAdapter(aiMinerModule) {
    if (!aiMinerModule || !aiMinerModule.mine) {
        console.warn('[AIMinerAdapter] aiMiner module not provided or invalid');
        return null;
    }
    
    const minerFn = async (job) => {
        const costTracker = getCostTracker();
        
        // Pre-check cost (AI is expensive)
        const canProceed = costTracker.canProceed(
            job.id,
            'AI_EXTRACTION',
            job.input
        );
        
        if (!canProceed.allowed) {
            console.warn(`[AIMinerAdapter] Cost limit reached: ${canProceed.reason}`);
            return {
                status: 'COST_LIMIT',
                emails: [],
                contacts: [],
                meta: { error: canProceed.reason }
            };
        }
        
        try {
            // Call original AI miner
            const result = await aiMinerModule.mine(job);
            
            // Count AI calls (estimate: 1 per block processed)
            const blocksProcessed = result.meta?.blocks_processed || 1;
            
            // Record costs
            for (let i = 0; i < blocksProcessed; i++) {
                const costResult = costTracker.recordCost(
                    job.id,
                    'AI_EXTRACTION',
                    job.input
                );
                
                // Stop if limit reached mid-process
                if (!costResult.allowed) {
                    console.warn(`[AIMinerAdapter] Cost limit reached during processing`);
                    break;
                }
            }
            
            // Record success
            costTracker.recordSuccess(job.input);
            
            // Enhance contacts with evidence (if not already present)
            if (result.contacts && result.contacts.length > 0) {
                result.contacts = result.contacts.map(contact => {
                    if (!contact.evidence) {
                        // AI extraction without explicit evidence
                        // The AI found this, but we don't have DOM proof
                        contact.evidence = createEvidence(EVIDENCE_TYPES.NONE, {
                            source: 'ai_extraction',
                            model: result.meta?.model || 'claude',
                            note: 'Extracted by AI without explicit DOM evidence'
                        });
                    }
                    return contact;
                });
            }
            
            return result;
            
        } catch (err) {
            // Record failure for circuit breaker
            costTracker.recordFailure(job.input, err.message);
            
            // Still record cost for failed AI calls (API was called)
            costTracker.recordCost(job.id, 'AI_EXTRACTION', job.input);
            
            throw err;
        }
    };
    
    const adapter = new BaseMinerAdapter('aiMiner', minerFn, {
        description: 'AI Miner - Claude-based intelligent extraction',
        priority: 4,  // Lower priority (more expensive)
        timeout: 120000  // 2 minutes
    });
    
    // AI Miner CAN use HTML cache (to avoid re-fetching pages)
    // But the AI extraction itself is always fresh
    adapter.shouldUseCache = () => true;
    
    return adapter;
}

/**
 * Estimate cost for AI mining job
 * @param {Object} job - Mining job
 * @returns {{estimatedCost: number, estimatedCalls: number}}
 */
function estimateAICost(job) {
    // Estimate based on config or defaults
    const maxPages = job.config?.max_pages || 10;
    const avgBlocksPerPage = 5;
    
    const estimatedCalls = maxPages * avgBlocksPerPage;
    const estimatedCost = estimatedCalls * OPERATION_COSTS.AI_EXTRACTION;
    
    return {
        estimatedCost,
        estimatedCalls,
        withinJobLimit: estimatedCost <= 2.00,
        withinUrlLimit: (OPERATION_COSTS.AI_EXTRACTION * avgBlocksPerPage) <= 0.10
    };
}

module.exports = {
    createAIMinerAdapter,
    estimateAICost
};
