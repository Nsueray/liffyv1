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
const fs = require('fs');
const path = require('path');
const os = require('os');

// Shadow Mode Integration (Phase 1 - Step C)
const { normalizeMinerOutput } = require('./normalizer');
const aggregationTrigger = require('./aggregationTrigger');

// Unified engine entry point (Step 3)
const superMinerEntry = require('./superMiner/services/superMinerEntry');

// Import result merger
let resultMerger;
try {
    resultMerger = require('./urlMiners/resultMerger');
    console.log('[MiningService] ✅ ResultMerger loaded');
} catch (e) {
    console.log('[MiningService] ⚠️ ResultMerger not available:', e.message);
}

// Pagination handler
const {
    buildPageUrl,
    detectTotalPages,
    fetchPage,
    createContentHash,
    DEFAULT_MAX_PAGES,
    DEFAULT_DELAY_MS
} = require('./superMiner/services/paginationHandler');

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
                miner_name: `miningService-${job.config?.mining_mode || 'full'}Mode`,
                duration_ms: 0,
                confidence_hint: null,
                source_url: job.input || null,
                page_title: null,
            },
        };

        const normalizationResult = normalizeMinerOutput(minerOutput);

        await aggregationTrigger.process({
            jobId: job.id,
            organizerId: job.organizer_id,
            normalizationResult: normalizationResult,
            metadata: {
                original_contact_count: contacts.length,
                source_url: job.input || null,
                mining_mode: job.config?.mining_mode || 'full',
            },
        });

        console.log(`[SHADOW_MODE] Completed for job ${job.id}: ${normalizationResult.stats.candidates_produced} candidates`);

    } catch (error) {
        console.error(`[SHADOW_MODE] Error for job ${job.id}:`, error.message);
    }
}

// ============================================
// PAGINATION HELPERS
// ============================================

/**
 * Detect pagination for a job URL and return page URLs.
 * @param {Object} job
 * @returns {Promise<{isPaginated: boolean, pageUrls: string[], totalPages: number}>}
 */
async function detectJobPagination(job) {
    const maxPages = job.config?.max_pages || DEFAULT_MAX_PAGES;

    // Check if URL has pagination signal
    const url = job.input || '';
    const hasPageParam = /[?&]page=\d+/i.test(url) || /\/page\/\d+/i.test(url);

    if (!hasPageParam) {
        return { isPaginated: false, pageUrls: [url], totalPages: 1 };
    }

    console.log(`[Pagination] URL has page param, detecting total pages...`);

    // Fetch page 1 to detect total
    let totalDetected = 1;
    try {
        const result = await fetchPage(url);
        if (!result.blocked && result.html) {
            totalDetected = detectTotalPages(result.html, url);
        }
    } catch (err) {
        console.warn(`[Pagination] Detection fetch failed: ${err.message}`);
    }

    if (totalDetected <= 1) {
        totalDetected = 5; // Conservative default
        console.log(`[Pagination] Could not detect total, using default: ${totalDetected}`);
    }

    const totalPages = Math.min(totalDetected, maxPages);

    if (totalPages <= 1) {
        return { isPaginated: false, pageUrls: [url], totalPages: 1 };
    }

    const pageUrls = [];
    for (let i = 1; i <= totalPages; i++) {
        pageUrls.push(buildPageUrl(url, i));
    }

    console.log(`[Pagination] Will mine ${totalPages} pages`);
    return { isPaginated: true, pageUrls, totalPages };
}

/**
 * Merge contacts from multiple page results (AI or full mode).
 * Deduplicates by email.
 * @param {Array} allContacts - Flat array of contact objects
 * @returns {Array} Deduplicated contacts
 */
function deduplicateContacts(allContacts) {
    const emailMap = new Map();
    const noEmailContacts = [];

    for (const c of allContacts) {
        const email = (c.email || c.emails?.[0] || '').toLowerCase();
        if (email) {
            if (!emailMap.has(email)) {
                emailMap.set(email, c);
            } else {
                // Merge: fill in missing fields from new contact
                const existing = emailMap.get(email);
                for (const key of Object.keys(c)) {
                    if (c[key] && !existing[key]) {
                        existing[key] = c[key];
                    }
                }
            }
        } else if (c.companyName || c.contactName || c.company_name || c.contact_name) {
            noEmailContacts.push(c);
        }
    }

    return [...emailMap.values(), ...noEmailContacts];
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
 * v5.1: Pagination support — mines all pages for paginated URLs
 */
async function runFullMining(job) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Full Mode] Starting for job ${job.id}`);
    console.log(`[Full Mode] URL: ${job.input}`);
    console.log(`${'='.repeat(60)}\n`);

    const availableMiners = [httpBasicMiner, playwrightTableMiner, playwrightDetailMiner].filter(m => m);
    const startTime = Date.now();

    // Detect pagination
    const pagination = await detectJobPagination(job);

    let allPageResults = [];

    if (pagination.isPaginated) {
        console.log(`[Full Mode] Paginated mining: ${pagination.totalPages} pages`);
        const delayMs = job.config?.list_page_delay_ms || DEFAULT_DELAY_MS;
        const seenHashes = new Set();
        let consecutiveEmpty = 0;

        for (let i = 0; i < pagination.pageUrls.length; i++) {
            const pageUrl = pagination.pageUrls[i];
            const pageNum = i + 1;
            console.log(`\n[Full Mode] --- Page ${pageNum}/${pagination.totalPages}: ${pageUrl}`);

            const pageJob = { ...job, input: pageUrl };
            const pageResults = [];

            for (const miner of availableMiners) {
                console.log(`[Full Mode] >>> Running ${miner.name} on page ${pageNum}...`);
                try {
                    const result = await miner.mine(pageJob);
                    pageResults.push(result);
                    console.log(`[Full Mode] <<< ${miner.name}: ${result.status}`);
                } catch (err) {
                    console.log(`[Full Mode] <<< ${miner.name} failed: ${err.message}`);
                }
            }

            // Merge this page's results
            let pageResult;
            if (resultMerger) {
                pageResult = resultMerger.mergeResults(pageResults);
            } else {
                pageResult = { status: 'PARTIAL', emails: [], contacts: [] };
            }

            const contacts = pageResult.contacts || [];
            if (contacts.length === 0) {
                consecutiveEmpty++;
                if (consecutiveEmpty >= 3) {
                    console.log(`[Full Mode] Stopping: 3 consecutive empty pages`);
                    break;
                }
            } else {
                consecutiveEmpty = 0;
                const hash = createContentHash(contacts);
                if (seenHashes.has(hash)) {
                    console.log(`[Full Mode] Page ${pageNum}: duplicate content, stopping`);
                    break;
                }
                seenHashes.add(hash);
                allPageResults.push(pageResult);
                console.log(`[Full Mode] Page ${pageNum}: ${contacts.length} contacts`);
            }

            if (i < pagination.pageUrls.length - 1) {
                await sleep(delayMs);
            }
        }
    } else {
        // Single page — original behavior
        const results = [];
        for (const miner of availableMiners) {
            console.log(`\n[Full Mode] >>> Running ${miner.name}...`);
            try {
                const result = await miner.mine(job);
                results.push(result);
                console.log(`[Full Mode] <<< ${miner.name}: ${result.status}`);
            } catch (err) {
                console.log(`[Full Mode] <<< ${miner.name} failed: ${err.message}`);
            }
        }

        let pageResult;
        if (resultMerger) {
            pageResult = resultMerger.mergeResults(results);
        } else {
            pageResult = { status: 'PARTIAL', emails: [], contacts: [] };
        }
        allPageResults.push(pageResult);
    }

    // Merge all pages
    let finalResult;
    if (allPageResults.length === 0) {
        finalResult = { status: 'EMPTY', emails: [], contacts: [] };
    } else if (allPageResults.length === 1) {
        finalResult = allPageResults[0];
    } else {
        // Merge across pages
        let allContacts = [];
        let allEmails = [];
        for (const pr of allPageResults) {
            allContacts.push(...(pr.contacts || []));
            allEmails.push(...(pr.emails || []));
        }
        allContacts = deduplicateContacts(allContacts);
        allEmails = [...new Set(allEmails)];
        finalResult = {
            status: allContacts.length > 0 ? 'SUCCESS' : 'EMPTY',
            contacts: allContacts,
            emails: allEmails
        };
    }

    // Shadow Mode Normalization (Phase 1 - Step C)
    await runShadowModeFromMergedResult(job, finalResult);

    // Save merged contacts
    if (finalResult.contacts?.length > 0) {
        await saveMergedResults(job, finalResult.contacts);
    }

    await updateJobStatus(job, finalResult, Date.now() - startTime);

    console.log(`\n[Full Mode] COMPLETED - ${finalResult.contacts?.length || 0} contacts`);
    if (pagination.isPaginated) {
        console.log(`[Full Mode] Pages mined: ${pagination.totalPages}`);
    }
    return finalResult;
}

/**
 * AI Mode - Claude AI extraction (BEST)
 * v5.1: Pagination support — mines all pages for paginated URLs
 */
async function runAIMining(job) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[AI Mode] Starting for job ${job.id}`);
    console.log(`[AI Mode] URL: ${job.input}`);
    console.log(`${'='.repeat(60)}\n`);

    if (!aiMiner) {
        throw new Error('AIMiner not available - check ANTHROPIC_API_KEY');
    }

    const startTime = Date.now();

    // Detect pagination
    const pagination = await detectJobPagination(job);

    let allContacts = [];
    let allEmails = [];

    if (pagination.isPaginated) {
        console.log(`[AI Mode] Paginated mining: ${pagination.totalPages} pages`);
        const delayMs = job.config?.list_page_delay_ms || DEFAULT_DELAY_MS;
        const seenHashes = new Set();
        let consecutiveEmpty = 0;

        for (let i = 0; i < pagination.pageUrls.length; i++) {
            const pageUrl = pagination.pageUrls[i];
            const pageNum = i + 1;
            console.log(`[AI Mode] --- Page ${pageNum}/${pagination.totalPages}: ${pageUrl}`);

            const pageJob = { ...job, input: pageUrl };
            try {
                const pageResult = await aiMiner.mine(pageJob);
                const contacts = pageResult.contacts || [];
                const emails = pageResult.emails || [];

                if (contacts.length === 0) {
                    consecutiveEmpty++;
                    if (consecutiveEmpty >= 3) {
                        console.log(`[AI Mode] Stopping: 3 consecutive empty pages`);
                        break;
                    }
                } else {
                    consecutiveEmpty = 0;
                    const hash = createContentHash(contacts);
                    if (seenHashes.has(hash)) {
                        console.log(`[AI Mode] Page ${pageNum}: duplicate content, stopping`);
                        break;
                    }
                    seenHashes.add(hash);
                    allContacts.push(...contacts);
                    allEmails.push(...emails);
                    console.log(`[AI Mode] Page ${pageNum}: ${contacts.length} contacts, ${emails.length} emails`);
                }
            } catch (err) {
                console.error(`[AI Mode] Page ${pageNum} failed: ${err.message}`);
            }

            // Polite delay between pages
            if (i < pagination.pageUrls.length - 1) {
                await sleep(delayMs);
            }
        }

        // Deduplicate across pages
        allContacts = deduplicateContacts(allContacts);
        allEmails = [...new Set(allEmails)];
        console.log(`[AI Mode] All pages: ${allContacts.length} unique contacts after dedup`);
    } else {
        // Single page — original behavior
        const result = await aiMiner.mine(job);
        allContacts = result.contacts || [];
        allEmails = result.emails || [];
    }

    const finalResult = {
        status: allContacts.length > 0 ? 'SUCCESS' : 'EMPTY',
        contacts: allContacts,
        emails: allEmails,
        meta: { source: 'aiMiner', pages_mined: pagination.totalPages }
    };

    // Save contacts to DB
    if (finalResult.contacts.length > 0) {
        await saveAIResults(job, finalResult.contacts);
    }

    // Aggregation trigger (canonical tables: persons + affiliations)
    await runShadowModeFromMergedResult(job, finalResult);

    await updateJobStatus(job, finalResult, Date.now() - startTime);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[AI Mode] COMPLETED in ${Date.now() - startTime}ms`);
    console.log(`[AI Mode] Total contacts: ${finalResult.contacts.length}`);
    console.log(`[AI Mode] Total emails: ${finalResult.emails.length}`);
    if (pagination.isPaginated) {
        console.log(`[AI Mode] Pages mined: ${pagination.totalPages}`);
    }
    console.log(`${'='.repeat(60)}\n`);

    return finalResult;
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
// HELPERS
// ============================================

/**
 * Check if URL points to a PDF file
 * @param {string} url 
 * @returns {boolean}
 */
function isPdfUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname.toLowerCase();
        return pathname.endsWith('.pdf');
    } catch (e) {
        return url.toLowerCase().endsWith('.pdf');
    }
}

/**
 * Download PDF from URL to temporary file
 * @param {string} url - PDF URL
 * @param {number} jobId - Job ID for filename
 * @returns {Promise<string>} - Path to downloaded file
 */
async function downloadPdfFromUrl(url, jobId) {
    const https = require('https');
    const http = require('http');
    
    const tempDir = os.tmpdir();
    const filename = `liffy_pdf_${jobId}_${Date.now()}.pdf`;
    const filePath = path.join(tempDir, filename);
    
    console.log(`[MiningService] Downloading PDF from: ${url}`);
    console.log(`[MiningService] Saving to: ${filePath}`);
    
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        
        const request = protocol.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
            },
            timeout: 60000
        }, (response) => {
            // Handle redirects
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                console.log(`[MiningService] Following redirect to: ${response.headers.location}`);
                downloadPdfFromUrl(response.headers.location, jobId)
                    .then(resolve)
                    .catch(reject);
                return;
            }
            
            if (response.statusCode !== 200) {
                reject(new Error(`HTTP ${response.statusCode}: Failed to download PDF`));
                return;
            }
            
            const fileStream = fs.createWriteStream(filePath);
            response.pipe(fileStream);
            
            fileStream.on('finish', () => {
                fileStream.close();
                console.log(`[MiningService] PDF downloaded successfully`);
                resolve(filePath);
            });
            
            fileStream.on('error', (err) => {
                fs.unlink(filePath, () => {});
                reject(err);
            });
        });
        
        request.on('error', (err) => {
            reject(err);
        });
        
        request.on('timeout', () => {
            request.destroy();
            reject(new Error('PDF download timeout'));
        });
    });
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

    // URL JOBS → Check for PDF URL before mining mode selection
    if (jobType === 'url') {
        // PDF URL Guard: Download PDF and route to File Orchestrator
        if (isPdfUrl(job.input)) {
            console.log(`[MiningService] PDF URL detected, downloading and routing to File Orchestrator`);
            
            let tempFilePath = null;
            
            try {
                // Download PDF to temp file
                tempFilePath = await downloadPdfFromUrl(job.input, job.id);
                
                // Read file into buffer for file_data
                const fileBuffer = fs.readFileSync(tempFilePath);
                console.log(`[MiningService] PDF loaded into buffer: ${fileBuffer.length} bytes`);
                
                // Extract filename from URL for extension detection
                const urlObj = new URL(job.input);
                const originalFilename = path.basename(urlObj.pathname) || 'downloaded.pdf';
                
                // Attach file_data to job for File Orchestrator
                job.file_data = fileBuffer;
                job.type = 'pdf';
                job.input = originalFilename;
                
                const result = await orchestrateFile(job);
                
                // Cleanup temp file after processing
                try {
                    fs.unlinkSync(tempFilePath);
                    console.log(`[MiningService] Temp PDF file cleaned up`);
                } catch (cleanupErr) {
                    console.log(`[MiningService] Temp file cleanup warning: ${cleanupErr.message}`);
                }
                
                return result;
                
            } catch (downloadErr) {
                console.error(`[MiningService] PDF download failed: ${downloadErr.message}`);
                
                // Cleanup temp file on error
                if (tempFilePath) {
                    try {
                        fs.unlinkSync(tempFilePath);
                    } catch (e) {}
                }
                
                // Mark job as failed
                await db.query(
                    `UPDATE mining_jobs SET status = 'failed', error = $1, completed_at = NOW() WHERE id = $2`,
                    [`PDF download failed: ${downloadErr.message}`, job.id]
                );
                
                return {
                    status: 'ERROR',
                    emails: [],
                    contacts: [],
                    meta: { error: `PDF download failed: ${downloadErr.message}` }
                };
            }
        }

        // Get mining mode from config (default to 'ai' for best quality)
        const mode = job.config?.mining_mode || 'ai';
        console.log(`[MiningService] Mining Mode: ${mode}`);

        // Unified Engine routing (Step 3)
        const USE_UNIFIED_ENGINE = process.env.USE_UNIFIED_ENGINE !== 'false';
        if (USE_UNIFIED_ENGINE) {
            console.log(`[MiningService] Job ${job.id}: Routing to unified engine (mode: ${mode})`);
            return superMinerEntry.runMiningJob(job, db);
        }

        // Legacy fallback below (only when USE_UNIFIED_ENGINE=false)
        console.log(`[MiningService] Job ${job.id}: Using legacy path (mode: ${mode})`);
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
