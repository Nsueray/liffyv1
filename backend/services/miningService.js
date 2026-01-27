/**
 * Mining Service v5 - Multi-Mode Mining Pipeline
 * 
 * Mining Modes:
 * - quick: Only HTTP miner (fast, free)
 * - full: All miners + merge (comprehensive, free)
 * - ai: Claude AI extraction (best quality, paid)
 * 
 * Mode is determined by job.config.mining_mode or defaults to 'ai'
 */

const { orchestrate: orchestrateFile } = require('./fileOrchestrator');
const db = require('../db');

// Shadow Mode Integration (Phase 1 - Step C)
const { normalizeMinerOutput } = require('./normalizer');
const aggregationTrigger = require('./aggregationTrigger');

// Import result merger
let resultMerger;
try {
    resultMerger = require('./urlMiners/resultMerger');
    console.log('[MiningService] ✅ ResultMerger loaded');
} catch (e) {
    console.log('[MiningService] ⚠️ ResultMerger not available:', e.message);
}

// ============================================
// MINERS
// ============================================

// HTTP Basic Miner
let httpBasicMiner = null;
try {
    const urlMinerModule = require('./urlMiner');
    httpBasicMiner = {
        name: 'HttpBasicMiner',
        mine: async (job) => {
            console.log(`[HttpBasicMiner] Starting...`);
            try {
                const result = await urlMinerModule.runUrlMiningJob(job.id, job.organizer_id);
                return {
                    status: (result.total_emails_raw || 0) > 0 ? 'SUCCESS' : 'PARTIAL',
                    emails: [],
                    contacts: [],
                    meta: { source: 'httpBasicMiner', total_emails: result.total_emails_raw || 0 }
                };
            } catch (err) {
                return { status: 'ERROR', emails: [], contacts: [], meta: { error: err.message } };
            }
        }
    };
    console.log('[MiningService] ✅ HttpBasicMiner loaded');
} catch (e) {
    console.log('[MiningService] ⚠️ HttpBasicMiner not available');
}

// Playwright Table Miner
let playwrightTableMiner = null;
try {
    const tableMinerModule = require('./urlMiners/playwrightTableMiner');
    playwrightTableMiner = {
        name: 'PlaywrightTableMiner',
        mine: async (job) => {
            console.log(`[PlaywrightTableMiner] Starting...`);
            return await tableMinerModule.mine(job);
        }
    };
    console.log('[MiningService] ✅ PlaywrightTableMiner loaded');
} catch (e) {
    console.log('[MiningService] ⚠️ PlaywrightTableMiner not available:', e.message);
}

// Playwright Detail Miner
let playwrightDetailMiner = null;
try {
    const { runMiningTest } = require('./miningWorker');
    playwrightDetailMiner = {
        name: 'PlaywrightDetailMiner',
        mine: async (job) => {
            console.log(`[PlaywrightDetailMiner] Starting...`);
            try {
                await runMiningTest(job);
                const countResult = await db.query(
                    'SELECT COUNT(*) as count FROM mining_results WHERE job_id = $1',
                    [job.id]
                );
                const resultCount = parseInt(countResult.rows[0]?.count || 0);
                return {
                    status: resultCount > 0 ? 'SUCCESS' : 'PARTIAL',
                    emails: [],
                    contacts: [],
                    meta: { source: 'playwrightDetailMiner', results_saved: resultCount }
                };
            } catch (err) {
                if (err.message?.includes('BLOCK_DETECTED')) {
                    return { status: 'BLOCKED', emails: [], contacts: [], meta: { error: 'BLOCKED' } };
                }
                return { status: 'ERROR', emails: [], contacts: [], meta: { error: err.message } };
            }
        }
    };
    console.log('[MiningService] ✅ PlaywrightDetailMiner loaded');
} catch (e) {
    console.log('[MiningService] ⚠️ PlaywrightDetailMiner not available');
}

// AI Miner (Claude)
let aiMiner = null;
try {
    const aiMinerModule = require('./urlMiners/aiMiner');
    aiMiner = {
        name: 'AIMiner',
        mine: async (job) => {
            console.log(`[AIMiner] Starting...`);
            return await aiMinerModule.mine(job);
        }
    };
    console.log('[MiningService] ✅ AIMiner loaded');
} catch (e) {
    console.log('[MiningService] ⚠️ AIMiner not available:', e.message);
}

// File Miner
let fileMiner = null;
try {
    fileMiner = require('./fileMiner');
    console.log('[MiningService] ✅ FileMiner loaded');
} catch (e) {
    console.log('[MiningService] ⚠️ FileMiner not available');
}

// ============================================
// SHADOW MODE HELPER (Phase 1 - Step C)
// ============================================

/**
 * Shadow Mode Normalization from Merged Result
 * Converts finalResult.contacts to normalized candidates and logs them
 * DOES NOT persist anything - LOG ONLY
 * 
 * @param {Object} job - Mining job object
 * @param {Object} finalResult - Merged result with contacts array
 */
async function runShadowModeFromMergedResult(job, finalResult) {
    if (process.env.DISABLE_SHADOW_MODE === 'true') {
        return;
    }

    try {
        console.log(`[SHADOW_MODE] Starting normalization for job ${job.id}`);

        const contacts = finalResult.contacts || [];

        const minerOutput = {
            status: 'success',
            raw: {
                text: '',
                html: '',
                blocks: contacts.map(c => ({
                    email: c.email || null,
                    emails: c.email ? [c.email] : [],
                    company_name: c.companyName || c.company_name || null,
                    contact_name: c.contactName || c.contact_name || null,
                    website: c.website || null,
                    country: c.country || null,
                    phone: c.phone || null,
                    text: null,
                    data: c,
                })),
                links: [],
            },
            meta: {
                miner_name: 'miningService-fullMode',
                duration_ms: 0,
                confidence_hint: null,
                source_url: job.input || null,
                page_title: null,
            },
        };

        const normalizationResult = normalizeMinerOutput(minerOutput);

        aggregationTrigger.process({
            jobId: job.id,
            normalizationResult: normalizationResult,
            metadata: {
                original_contact_count: contacts.length,
                source_url: job.input || null,
                mining_mode: 'full',
            },
        });

        console.log(`[SHADOW_MODE] Completed for job ${job.id}: ${normalizationResult.stats.candidates_produced} candidates`);

    } catch (error) {
        console.error(`[SHADOW_MODE] Error for job ${job.id}:`, error.message);
    }
}

// ============================================
// MINING MODES
// ============================================

/**
 * Quick Mode - Only HTTP miner
 */
async function runQuickMining(job) {
    console.log(`\n[Quick Mode] Starting for job ${job.id}`);
    
    if (!httpBasicMiner) {
        throw new Error('HttpBasicMiner not available');
    }
    
    const result = await httpBasicMiner.mine(job);
    await updateJobStatus(job, result, 0);
    return result;
}

/**
 * Full Mode - All miners + merge
 */
async function runFullMining(job) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Full Mode] Starting for job ${job.id}`);
    console.log(`[Full Mode] URL: ${job.input}`);
    console.log(`${'='.repeat(60)}\n`);
    
    const miners = [httpBasicMiner, playwrightTableMiner, playwrightDetailMiner].filter(m => m);
    const results = [];
    const startTime = Date.now();
    
    for (const miner of miners) {
        console.log(`\n[Full Mode] >>> Running ${miner.name}...`);
        try {
            const result = await miner.mine(job);
            results.push(result);
            console.log(`[Full Mode] <<< ${miner.name}: ${result.status}`);
        } catch (err) {
            console.log(`[Full Mode] <<< ${miner.name} failed: ${err.message}`);
        }
    }
    
    // Merge results
    let finalResult;
    if (resultMerger) {
        finalResult = resultMerger.mergeResults(results);
    } else {
        finalResult = { status: 'PARTIAL', emails: [], contacts: [] };
    }
    
    // Shadow Mode Normalization (Phase 1 - Step C)
    await runShadowModeFromMergedResult(job, finalResult);
    
    // Save merged contacts
    if (finalResult.contacts?.length > 0) {
        await saveMergedResults(job, finalResult.contacts);
    }
    
    await updateJobStatus(job, finalResult, Date.now() - startTime);
    
    console.log(`\n[Full Mode] COMPLETED - ${finalResult.contacts?.length || 0} contacts`);
    return finalResult;
}

/**
 * AI Mode - Claude AI extraction (BEST)
 */
async function runAIMining(job) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[AI Mode] 🤖 Starting for job ${job.id}`);
    console.log(`[AI Mode] URL: ${job.input}`);
    console.log(`${'='.repeat(60)}\n`);
    
    if (!aiMiner) {
        throw new Error('AIMiner not available - check ANTHROPIC_API_KEY');
    }
    
    const startTime = Date.now();
    const result = await aiMiner.mine(job);
    
    // Save contacts to DB
    if (result.contacts?.length > 0) {
        await saveAIResults(job, result.contacts);
    }
    
    await updateJobStatus(job, result, Date.now() - startTime);
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[AI Mode] ✅ COMPLETED in ${Date.now() - startTime}ms`);
    console.log(`[AI Mode] Total contacts: ${result.contacts?.length || 0}`);
    console.log(`[AI Mode] Total emails: ${result.emails?.length || 0}`);
    console.log(`${'='.repeat(60)}\n`);
    
    return result;
}

// ============================================
// DB HELPERS
// ============================================

async function saveAIResults(job, contacts) {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        
        let savedCount = 0;
        for (const contact of contacts) {
            const email = contact.email?.toLowerCase();
            if (!email) continue;
            
            // Check if exists
            const existing = await client.query(
                'SELECT id FROM mining_results WHERE job_id = $1 AND $2 = ANY(emails)',
                [job.id, email]
            );
            
            if (existing.rows.length === 0) {
                await client.query(`
                    INSERT INTO mining_results 
                    (job_id, organizer_id, source_url, company_name, contact_name, job_title, phone, country, website, emails, raw)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                `, [
                    job.id,
                    job.organizer_id,
                    job.input,
                    contact.companyName || contact.company_name,
                    contact.contactName || contact.contact_name,
                    contact.jobTitle || contact.job_title,
                    contact.phone,
                    contact.country || contact.state || contact.city,
                    contact.website,
                    [email],
                    JSON.stringify({
                        ...contact,
                        address: contact.address,
                        city: contact.city,
                        state: contact.state,
                        extracted_by: 'aiMiner'
                    })
                ]);
                savedCount++;
            }
        }
        
        await client.query('COMMIT');
        console.log(`[AI Mode] 💾 Saved ${savedCount} contacts to DB`);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[AI Mode] Save error:', err.message);
    } finally {
        client.release();
    }
}

async function saveMergedResults(job, contacts) {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        
        let savedCount = 0;
        for (const contact of contacts) {
            const email = contact.email?.toLowerCase();
            if (!email) continue;
            
            const existing = await client.query(
                'SELECT id FROM mining_results WHERE job_id = $1 AND $2 = ANY(emails)',
                [job.id, email]
            );
            
            if (existing.rows.length > 0) {
                await client.query(`
                    UPDATE mining_results SET
                        company_name = COALESCE(NULLIF($1, ''), company_name),
                        contact_name = COALESCE(NULLIF($2, ''), contact_name),
                        phone = COALESCE(NULLIF($3, ''), phone),
                        country = COALESCE(NULLIF($4, ''), country),
                        website = COALESCE(NULLIF($5, ''), website)
                    WHERE job_id = $6 AND $7 = ANY(emails)
                `, [
                    contact.companyName,
                    contact.contactName,
                    contact.phone,
                    contact.country,
                    contact.website,
                    job.id,
                    email
                ]);
            } else {
                await client.query(`
                    INSERT INTO mining_results 
                    (job_id, organizer_id, source_url, company_name, contact_name, phone, country, website, emails, raw)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                `, [
                    job.id,
                    job.organizer_id,
                    job.input,
                    contact.companyName,
                    contact.contactName,
                    contact.phone,
                    contact.country,
                    contact.website,
                    [email],
                    JSON.stringify(contact)
                ]);
                savedCount++;
            }
        }
        
        await client.query('COMMIT');
        console.log(`[Full Mode] 💾 Saved ${savedCount} contacts`);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[Full Mode] Save error:', err.message);
    } finally {
        client.release();
    }
}

async function updateJobStatus(job, result, executionTime) {
    try {
        const status = result.status === 'BLOCKED' ? 'blocked' : 'completed';
        
        await db.query(`
            UPDATE mining_jobs SET
                status = $1,
                total_found = $2,
                total_emails_raw = $3,
                stats = COALESCE(stats, '{}'::jsonb) || $4::jsonb,
                completed_at = NOW()
            WHERE id = $5
        `, [
            status,
            result.contacts?.length || 0,
            result.emails?.length || 0,
            JSON.stringify({
                mining_mode: result.meta?.source || 'unknown',
                execution_time_ms: executionTime,
                pipeline_version: 'v5'
            }),
            job.id
        ]);
    } catch (err) {
        console.error('[MiningService] Status update error:', err.message);
    }
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

    // FILE JOBS → File Orchestrator
    if (jobType === 'file') {
        console.log(`[MiningService] Routing to File Orchestrator`);
        return orchestrateFile(job);
    }

    // URL JOBS → Select mining mode
    if (jobType === 'url') {
        // Get mining mode from config (default to 'ai' for best quality)
        const mode = job.config?.mining_mode || 'ai';
        console.log(`[MiningService] Mining Mode: ${mode}`);
        
        switch (mode) {
            case 'quick':
                return runQuickMining(job);
            case 'full':
                return runFullMining(job);
            case 'ai':
            default:
                return runAIMining(job);
        }
    }

    throw new Error(`Unknown job type: ${job.type}`);
}

function normalizeJobType(type) {
    const fileTypes = ['file', 'pdf', 'excel', 'word', 'csv', 'other'];
    if (fileTypes.includes(type)) return 'file';
    if (type === 'url') return 'url';
    return 'unknown';
}

module.exports = {
    processMiningJob,
    normalizeJobType,
    runQuickMining,
    runFullMining,
    runAIMining,
};
