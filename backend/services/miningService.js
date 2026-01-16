/**
 * Mining Service
 * Routes jobs to appropriate miners
 * 
 * - URL jobs → miningWorker (Playwright) via Orchestrator
 * - File jobs → fileOrchestrator (new system)
 * 
 * v2 - Fixed: Proper wrappers for orchestrator compatibility
 * 
 * FLOW PRESERVED:
 * 1. Orchestrator tries miners in sequence (axios → playwright)
 * 2. On BLOCK_DETECTED → triggers email for manual mining
 * 3. Manual mining from local Mac pushes results to liffy.app
 */

const { orchestrate: orchestrateMining } = require('./miningOrchestrator');
const { orchestrate: orchestrateFile } = require('./fileOrchestrator');

// ============================================
// URL MINERS WITH ORCHESTRATOR-COMPATIBLE WRAPPERS
// ============================================

let axiosMiner = null;
let playwrightMiner = null;

/**
 * Axios/HTTP Miner (urlMiner.js)
 * Lightweight HTTP-based scraping, tried first
 */
try {
    const urlMinerModule = require('./urlMiner');
    
    // Wrapper: Convert runUrlMiningJob to ScrapeResult format
    axiosMiner = async (job) => {
        try {
            // urlMiner expects (jobId, organizerId) not job object
            const result = await urlMinerModule.runUrlMiningJob(job.id, job.organizer_id);
            
            return {
                status: result.success ? "SUCCESS" : "ERROR",
                emails: [], // Already saved to DB by urlMiner
                extracted_links: [],
                http_code: result.success ? 200 : 500,
                meta: {
                    source: "urlMiner",
                    job_id: job.id,
                    total_emails_raw: result.total_emails_raw || 0,
                    total_prospects_created: result.total_prospects_created || 0,
                    list_id: result.list_id,
                    stats: result.stats
                }
            };
        } catch (err) {
            console.log(`[MiningService] urlMiner error: ${err.message}`);
            // Return ERROR so orchestrator tries next miner
            return {
                status: "ERROR",
                emails: [],
                extracted_links: [],
                http_code: null,
                meta: {
                    source: "urlMiner",
                    error: err.message
                }
            };
        }
    };
    
    console.log('[MiningService] ✅ AxiosMiner (urlMiner) loaded');
} catch (e) {
    console.log('[MiningService] ⚠️ urlMiner not available:', e.message);
}

/**
 * Playwright Miner (miningWorker.js)
 * Full browser-based scraping, tried if axios fails
 * Throws BLOCK_DETECTED for manual mining trigger
 */
try {
    const { runMiningTest } = require('./miningWorker');
    
    // Wrapper: Convert runMiningTest to ScrapeResult format
    playwrightMiner = async (job) => {
        try {
            // runMiningTest saves results directly to DB
            await runMiningTest(job);
            
            return {
                status: "SUCCESS",
                emails: [], // Already saved to DB by miningWorker
                extracted_links: [],
                http_code: 200,
                meta: {
                    source: "playwrightMiner",
                    job_id: job.id,
                    note: "Results saved directly to DB"
                }
            };
        } catch (err) {
            // CRITICAL: Preserve BLOCK_DETECTED for manual mining trigger
            if (err.message && err.message.includes("BLOCK_DETECTED")) {
                console.log(`[MiningService] 🚫 BLOCK detected for job ${job.id} → Manual mining will be triggered`);
                return {
                    status: "BLOCKED",
                    emails: [],
                    extracted_links: [],
                    http_code: 403,
                    meta: {
                        source: "playwrightMiner",
                        job_id: job.id,
                        error: "BLOCK_DETECTED",
                        note: "Site blocked - manual mining required"
                    }
                };
            }
            
            // Other errors - let orchestrator handle
            throw err;
        }
    };
    
    console.log('[MiningService] ✅ PlaywrightMiner (miningWorker) loaded');
} catch (e) {
    console.log('[MiningService] ⚠️ miningWorker not available:', e.message);
}

// ============================================
// FILE MINER (legacy fallback)
// ============================================

let fileMiner = null;
try {
    fileMiner = require('./fileMiner');
    console.log('[MiningService] ✅ FileMiner loaded');
} catch (e) {
    console.log('[MiningService] ⚠️ legacy fileMiner not available');
}

// ============================================
// MAIN PROCESSOR
// ============================================

/**
 * Process a mining job
 * @param {Object} job - Mining job from database
 * @returns {Promise<Object>} - Mining result
 */
async function processMiningJob(job) {
    const jobType = normalizeJobType(job.type);
    
    console.log(`[MiningService] Processing job ${job.id}`);
    console.log(`[MiningService] Type: ${jobType}, Input: ${job.input}`);
    console.log(`[MiningService] Miners loaded: axios=${!!axiosMiner}, playwright=${!!playwrightMiner}, file=${!!fileMiner}`);

    // FILE JOBS → New File Orchestrator
    if (jobType === 'file') {
        console.log(`[MiningService] Routing to File Orchestrator`);
        return orchestrateFile(job);
    }

    // URL JOBS → Original Orchestrator with miner sequence
    if (jobType === 'url') {
        console.log(`[MiningService] Routing to URL Mining Orchestrator`);
        
        return orchestrateMining(job, {
            axiosMiner: axiosMiner,           // HTTP-based (tried first)
            playwrightMiner: playwrightMiner, // Browser-based (tried second)
            fileMiner: fileMiner?.runFileMining
        });
    }

    // Unknown type
    throw new Error(`Unknown job type: ${job.type}`);
}

/**
 * Normalize job type
 */
function normalizeJobType(type) {
    const fileTypes = ['file', 'pdf', 'excel', 'word', 'csv', 'other'];
    if (fileTypes.includes(type)) return 'file';
    if (type === 'url') return 'url';
    return 'unknown';
}

module.exports = {
    processMiningJob,
    normalizeJobType,
};
