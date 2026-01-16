/**
 * Mining Service v4 - Full Mining Pipeline
 * 
 * Philosophy: Run ALL miners, merge results, get richest data
 * 
 * URL Mining Pipeline:
 * 1. httpBasicMiner (urlMiner.js) - Fast HTTP scraping
 * 2. playwrightTableMiner (urlMiners/) - Single page tables
 * 3. playwrightDetailMiner (miningWorker.js) - Detail page crawler
 * 
 * All results are merged by resultMerger to produce enriched contacts
 * 
 * File jobs still use fileOrchestrator (unchanged)
 */

const { orchestrate: orchestrateFile } = require('./fileOrchestrator');
const db = require('../db');

// Import result merger
let resultMerger;
try {
    resultMerger = require('./urlMiners/resultMerger');
    console.log('[MiningService] ✅ ResultMerger loaded');
} catch (e) {
    console.log('[MiningService] ⚠️ ResultMerger not available:', e.message);
}

// ============================================
// URL MINERS - All will be tried
// ============================================

const urlMiners = [];

/**
 * 1. HTTP Basic Miner (urlMiner.js)
 * Fast, lightweight, for simple HTML sites
 */
try {
    const urlMinerModule = require('./urlMiner');
    
    const httpBasicMiner = {
        name: 'HttpBasicMiner',
        mine: async (job) => {
            console.log(`[HttpBasicMiner] Starting for job ${job.id}`);
            try {
                const result = await urlMinerModule.runUrlMiningJob(job.id, job.organizer_id);
                const emailCount = result.total_emails_raw || 0;
                console.log(`[HttpBasicMiner] Found ${emailCount} emails`);
                
                return {
                    status: emailCount > 0 ? 'SUCCESS' : 'PARTIAL',
                    emails: [], // Already saved to DB by urlMiner
                    contacts: [],
                    extracted_links: [],
                    http_code: 200,
                    meta: {
                        source: 'httpBasicMiner',
                        total_emails: emailCount,
                        saved_to_db: true
                    }
                };
            } catch (err) {
                console.log(`[HttpBasicMiner] Error: ${err.message}`);
                return {
                    status: 'ERROR',
                    emails: [],
                    contacts: [],
                    extracted_links: [],
                    http_code: null,
                    meta: { source: 'httpBasicMiner', error: err.message }
                };
            }
        }
    };
    
    urlMiners.push(httpBasicMiner);
    console.log('[MiningService] ✅ HttpBasicMiner loaded');
} catch (e) {
    console.log('[MiningService] ⚠️ HttpBasicMiner not available:', e.message);
}

/**
 * 2. Playwright Table Miner (urlMiners/playwrightTableMiner.js)
 * For single-page sites with tables/lists (e.g., TotalEnergies distributors)
 */
try {
    const tableMinerModule = require('./urlMiners/playwrightTableMiner');
    
    const playwrightTableMiner = {
        name: 'PlaywrightTableMiner',
        mine: async (job) => {
            console.log(`[PlaywrightTableMiner] Starting for job ${job.id}`);
            try {
                const result = await tableMinerModule.mine(job);
                console.log(`[PlaywrightTableMiner] Found ${result.emails?.length || 0} emails, ${result.contacts?.length || 0} contacts`);
                return result;
            } catch (err) {
                console.log(`[PlaywrightTableMiner] Error: ${err.message}`);
                return {
                    status: 'ERROR',
                    emails: [],
                    contacts: [],
                    extracted_links: [],
                    http_code: null,
                    meta: { source: 'playwrightTableMiner', error: err.message }
                };
            }
        }
    };
    
    urlMiners.push(playwrightTableMiner);
    console.log('[MiningService] ✅ PlaywrightTableMiner loaded');
} catch (e) {
    console.log('[MiningService] ⚠️ PlaywrightTableMiner not available:', e.message);
}

/**
 * 3. Playwright Detail Miner (miningWorker.js)
 * For sites with detail pages (exhibitor lists, etc.)
 */
try {
    const { runMiningTest } = require('./miningWorker');
    
    const playwrightDetailMiner = {
        name: 'PlaywrightDetailMiner',
        mine: async (job) => {
            console.log(`[PlaywrightDetailMiner] Starting for job ${job.id}`);
            try {
                await runMiningTest(job);
                
                // Check results saved by miningWorker
                const countResult = await db.query(
                    'SELECT COUNT(*) as count FROM mining_results WHERE job_id = $1',
                    [job.id]
                );
                const resultCount = parseInt(countResult.rows[0]?.count || 0);
                console.log(`[PlaywrightDetailMiner] Saved ${resultCount} results to DB`);
                
                return {
                    status: resultCount > 0 ? 'SUCCESS' : 'PARTIAL',
                    emails: [],
                    contacts: [],
                    extracted_links: [],
                    http_code: 200,
                    meta: {
                        source: 'playwrightDetailMiner',
                        results_saved: resultCount,
                        saved_to_db: true
                    }
                };
            } catch (err) {
                if (err.message?.includes('BLOCK_DETECTED')) {
                    console.log(`[PlaywrightDetailMiner] 🚫 BLOCKED`);
                    return {
                        status: 'BLOCKED',
                        emails: [],
                        contacts: [],
                        extracted_links: [],
                        http_code: 403,
                        meta: { source: 'playwrightDetailMiner', error: 'BLOCK_DETECTED' }
                    };
                }
                console.log(`[PlaywrightDetailMiner] Error: ${err.message}`);
                return {
                    status: 'ERROR',
                    emails: [],
                    contacts: [],
                    extracted_links: [],
                    http_code: null,
                    meta: { source: 'playwrightDetailMiner', error: err.message }
                };
            }
        }
    };
    
    urlMiners.push(playwrightDetailMiner);
    console.log('[MiningService] ✅ PlaywrightDetailMiner loaded');
} catch (e) {
    console.log('[MiningService] ⚠️ PlaywrightDetailMiner not available:', e.message);
}

// ============================================
// FILE MINER (unchanged)
// ============================================

let fileMiner = null;
try {
    fileMiner = require('./fileMiner');
    console.log('[MiningService] ✅ FileMiner loaded');
} catch (e) {
    console.log('[MiningService] ⚠️ FileMiner not available');
}

// ============================================
// FULL MINING PIPELINE
// ============================================

/**
 * Run all URL miners and merge results
 */
async function runFullMiningPipeline(job) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Pipeline] Starting FULL mining for job ${job.id}`);
    console.log(`[Pipeline] URL: ${job.input}`);
    console.log(`[Pipeline] Miners available: ${urlMiners.map(m => m.name).join(', ')}`);
    console.log(`${'='.repeat(60)}\n`);
    
    const results = [];
    const startTime = Date.now();
    
    // Run ALL miners
    for (const miner of urlMiners) {
        console.log(`\n[Pipeline] >>> Running ${miner.name}...`);
        const minerStart = Date.now();
        
        try {
            const result = await miner.mine(job);
            result.meta = result.meta || {};
            result.meta.execution_time_ms = Date.now() - minerStart;
            results.push(result);
            
            console.log(`[Pipeline] <<< ${miner.name} completed in ${Date.now() - minerStart}ms`);
            console.log(`[Pipeline]     Status: ${result.status}, Emails: ${result.emails?.length || 0}, Contacts: ${result.contacts?.length || 0}`);
        } catch (err) {
            console.log(`[Pipeline] <<< ${miner.name} failed: ${err.message}`);
            results.push({
                status: 'ERROR',
                emails: [],
                contacts: [],
                extracted_links: [],
                http_code: null,
                meta: { source: miner.name, error: err.message }
            });
        }
    }
    
    // Merge results
    console.log(`\n[Pipeline] Merging results from ${results.length} miners...`);
    
    let finalResult;
    if (resultMerger) {
        finalResult = resultMerger.mergeResults(results);
    } else {
        // Fallback: just combine emails
        const allEmails = new Set();
        for (const r of results) {
            (r.emails || []).forEach(e => allEmails.add(e));
        }
        finalResult = {
            status: allEmails.size > 0 ? 'SUCCESS' : 'PARTIAL',
            emails: Array.from(allEmails),
            contacts: [],
            meta: { source: 'fallback_merger' }
        };
    }
    
    // Save merged contacts to DB (if not already saved by individual miners)
    if (finalResult.contacts && finalResult.contacts.length > 0) {
        console.log(`[Pipeline] Saving ${finalResult.contacts.length} merged contacts to DB...`);
        await saveMergedResults(job, finalResult.contacts);
    }
    
    const totalTime = Date.now() - startTime;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Pipeline] COMPLETED in ${totalTime}ms`);
    console.log(`[Pipeline] Total unique emails: ${finalResult.emails?.length || 0}`);
    console.log(`[Pipeline] Total contacts: ${finalResult.contacts?.length || 0}`);
    console.log(`[Pipeline] Status: ${finalResult.status}`);
    console.log(`${'='.repeat(60)}\n`);
    
    // Update job status
    await updateJobStatus(job, finalResult, totalTime);
    
    return finalResult;
}

/**
 * Save merged contacts to mining_results
 */
async function saveMergedResults(job, contacts) {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        
        let savedCount = 0;
        for (const contact of contacts) {
            // Check if email already exists for this job
            const existing = await client.query(
                'SELECT id FROM mining_results WHERE job_id = $1 AND $2 = ANY(emails)',
                [job.id, contact.email]
            );
            
            if (existing.rows.length > 0) {
                // Update existing with richer data
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
                    contact.phones?.join(', ') || contact.phone,
                    contact.country,
                    contact.website,
                    job.id,
                    contact.email
                ]);
            } else {
                // Insert new
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
                    contact.phones?.join(', ') || contact.phone,
                    contact.country,
                    contact.website,
                    [contact.email],
                    JSON.stringify(contact)
                ]);
                savedCount++;
            }
        }
        
        await client.query('COMMIT');
        console.log(`[Pipeline] Saved ${savedCount} new contacts, updated others`);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[Pipeline] Save error:', err.message);
    } finally {
        client.release();
    }
}

/**
 * Update job status after pipeline completes
 */
async function updateJobStatus(job, result, executionTime) {
    try {
        const status = result.status === 'SUCCESS' ? 'completed' : 
                       result.wasBlocked ? 'blocked' : 'completed';
        
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
                pipeline_version: 'v4',
                execution_time_ms: executionTime,
                miners_used: result.meta?.miners_used || urlMiners.length,
                enrichment_rate: result.meta?.enrichment_rate || 0
            }),
            job.id
        ]);
    } catch (err) {
        console.error('[Pipeline] Status update error:', err.message);
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

    // FILE JOBS → File Orchestrator (unchanged)
    if (jobType === 'file') {
        console.log(`[MiningService] Routing to File Orchestrator`);
        return orchestrateFile(job);
    }

    // URL JOBS → Full Mining Pipeline
    if (jobType === 'url') {
        console.log(`[MiningService] Routing to Full Mining Pipeline`);
        return runFullMiningPipeline(job);
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
    runFullMiningPipeline,
};
