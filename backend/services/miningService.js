/**
 * Mining Service
 * Routes jobs to appropriate miners
 * 
 * - URL jobs → miningWorker (Playwright) via Orchestrator
 * - File jobs → fileOrchestrator (new system)
 * 
 * v3 - Fixed: PARTIAL status when no emails found (triggers next miner)
 * 
 * FLOW:
 * 1. AxiosMiner (HTTP/Cheerio) - fast, for simple sites
 *    → SUCCESS (emails found) → STOP
 *    → PARTIAL (no emails) → TRY NEXT
 *    → ERROR → TRY NEXT
 * 
 * 2. PlaywrightMiner (Browser) - for JS-rendered sites
 *    → SUCCESS/PARTIAL/BLOCKED
 * 
 * 3. On BLOCK_DETECTED → Email sent for manual mining from local Mac
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
 * Good for simple HTML sites, fails on JS-rendered content
 */
try {
    const urlMinerModule = require('./urlMiner');
    
    axiosMiner = async (job) => {
        console.log(`[AxiosMiner] Starting for job ${job.id}`);
        
        try {
            const result = await urlMinerModule.runUrlMiningJob(job.id, job.organizer_id);
            
            const emailCount = result.total_emails_raw || 0;
            console.log(`[AxiosMiner] Found ${emailCount} emails`);
            
            // CRITICAL: If no emails found, return PARTIAL so next miner is tried
            if (emailCount === 0) {
                console.log(`[AxiosMiner] No emails found → returning PARTIAL to try PlaywrightMiner`);
                return {
                    status: "PARTIAL",
                    emails: [],
                    extracted_links: [],
                    http_code: 200,
                    meta: {
                        source: "urlMiner",
                        job_id: job.id,
                        note: "No emails found with HTTP scraping, site may need browser rendering"
                    }
                };
            }
            
            // Emails found - success
            return {
                status: "SUCCESS",
                emails: [], // Already saved to DB
                extracted_links: [],
                http_code: 200,
                meta: {
                    source: "urlMiner",
                    job_id: job.id,
                    total_emails_raw: emailCount,
                    total_prospects_created: result.total_prospects_created || 0,
                    list_id: result.list_id
                }
            };
            
        } catch (err) {
            console.log(`[AxiosMiner] Error: ${err.message} → trying next miner`);
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
 * Full browser-based scraping for JS-rendered sites
 * Throws BLOCK_DETECTED for manual mining trigger
 */
try {
    const { runMiningTest } = require('./miningWorker');
    
    playwrightMiner = async (job) => {
        console.log(`[PlaywrightMiner] Starting for job ${job.id}`);
        
        try {
            await runMiningTest(job);
            
            // Check how many results were saved
            // miningWorker saves directly to DB, we need to check
            const db = require('../db');
            const countResult = await db.query(
                'SELECT COUNT(*) as count FROM mining_results WHERE job_id = $1',
                [job.id]
            );
            const resultCount = parseInt(countResult.rows[0]?.count || 0);
            
            console.log(`[PlaywrightMiner] Saved ${resultCount} results to DB`);
            
            if (resultCount === 0) {
                console.log(`[PlaywrightMiner] No results found → PARTIAL`);
                return {
                    status: "PARTIAL",
                    emails: [],
                    extracted_links: [],
                    http_code: 200,
                    meta: {
                        source: "playwrightMiner",
                        job_id: job.id,
                        note: "Browser scraping completed but no contacts found"
                    }
                };
            }
            
            return {
                status: "SUCCESS",
                emails: [],
                extracted_links: [],
                http_code: 200,
                meta: {
                    source: "playwrightMiner",
                    job_id: job.id,
                    results_saved: resultCount
                }
            };
            
        } catch (err) {
            // CRITICAL: Preserve BLOCK_DETECTED for manual mining
            if (err.message && err.message.includes("BLOCK_DETECTED")) {
                console.log(`[PlaywrightMiner] 🚫 BLOCK detected → Manual mining will be triggered`);
                return {
                    status: "BLOCKED",
                    emails: [],
                    extracted_links: [],
                    http_code: 403,
                    meta: {
                        source: "playwrightMiner",
                        job_id: job.id,
                        error: "BLOCK_DETECTED",
                        note: "Site blocked - manual mining required from local Mac"
                    }
                };
            }
            
            console.log(`[PlaywrightMiner] Error: ${err.message}`);
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
 */
async function processMiningJob(job) {
    const jobType = normalizeJobType(job.type);
    
    console.log(`[MiningService] Processing job ${job.id}`);
    console.log(`[MiningService] Type: ${jobType}, Input: ${job.input}`);
    console.log(`[MiningService] Miners loaded: axios=${!!axiosMiner}, playwright=${!!playwrightMiner}, file=${!!fileMiner}`);

    // FILE JOBS → File Orchestrator
    if (jobType === 'file') {
        console.log(`[MiningService] Routing to File Orchestrator`);
        return orchestrateFile(job);
    }

    // URL JOBS → Mining Orchestrator with miner sequence
    if (jobType === 'url') {
        console.log(`[MiningService] Routing to URL Mining Orchestrator`);
        
        return orchestrateMining(job, {
            axiosMiner: axiosMiner,           // HTTP-based (tried first)
            playwrightMiner: playwrightMiner, // Browser-based (tried if axios fails/partial)
            fileMiner: fileMiner?.runFileMining
        });
    }

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
