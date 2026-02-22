/**
 * flowOrchestrator.js - SuperMiner v3.2
 *
 * Ana akış kontrolü - Flow 1 ve Flow 2 yönetimi.
 *
 * PDF MİMARİSİ:
 * - Flow 1: Scout → Router → Miners → Aggregator V1 → Redis (DB'ye YAZMAZ!)
 * - Event: mining:aggregation:done
 * - Flow 2: WebsiteScraper → Aggregator V2 → DB (tek seferde)
 *
 * KURALLAR:
 * - Miner'lar sadece sonuç döner, DB'ye yazmaz
 * - Aggregator V1 Redis'e yazar (temp_results:{jobId})
 * - Aggregator V2 DB'ye yazar (final merge)
 *
 * v3.2 CHANGELOG:
 * - FEAT: Pagination support — multi-page mining for paginated sites
 * - FlowOrchestrator now detects pagination via PageAnalyzer/SmartRouter hints
 *   and iterates through all pages, merging results before aggregation
 *
 * v3.1.6 CHANGELOG:
 * - FIX: normalizeResult() now handles both camelCase and snake_case field names
 * - aiMiner returns companyName (camelCase), we now check both formats
 */

const { getSmartRouter } = require('./smartRouter');
const { getCircuitBreaker } = require('./circuitBreaker');
const { getCostTracker } = require('./costTracker');
const { getHtmlCache } = require('./htmlCache');
const { createResultAggregator, ENRICHMENT_THRESHOLD } = require('./resultAggregator');
const { getEventBus, CHANNELS } = require('./eventBus');
const { getIntermediateStorage } = require('./intermediateStorage');
const { getPageAnalyzer, PAGE_TYPES, PAGINATION_TYPES } = require('./pageAnalyzer');
const { buildExecutionPlan } = require('./executionPlanBuilder');
const documentTextNormalizer = require('./documentTextNormalizer');
const { UnifiedContact } = require('../types/UnifiedContact');
const {
    buildPageUrl,
    detectTotalPages,
    fetchPage,
    createContentHash,
    DEFAULT_MAX_PAGES,
    DEFAULT_DELAY_MS
} = require('./paginationHandler');

// Flow states
const FLOW_STATE = {
    PENDING: 'pending',
    FLOW1_RUNNING: 'flow1_running',
    FLOW1_COMPLETE: 'flow1_complete',
    FLOW2_RUNNING: 'flow2_running',
    FLOW2_COMPLETE: 'flow2_complete',
    COMPLETED: 'completed',
    FAILED: 'failed'
};

// Default config
const DEFAULT_CONFIG = {
    maxMinersPerJob: 3,
    enableFlow2: true,
    flow2Threshold: ENRICHMENT_THRESHOLD,
    maxFlow2Websites: 20,
    timeoutMs: 300000, // 5 minutes
    enablePagination: true,
    maxPages: DEFAULT_MAX_PAGES,
    pageDelayMs: DEFAULT_DELAY_MS
};

class FlowOrchestrator {
    constructor(db, config = {}) {
        this.db = db;
        this.config = { ...DEFAULT_CONFIG, ...config };

        // Services
        this.router = getSmartRouter();
        this.circuitBreaker = getCircuitBreaker();
        this.costTracker = getCostTracker();
        this.htmlCache = getHtmlCache();
        this.eventBus = getEventBus();
        this.storage = getIntermediateStorage();

        // Aggregator (needs db)
        this.aggregator = createResultAggregator(db);

        // Miner modules (lazy loaded)
        this.miners = null;

        // Job tracking
        this.activeJobs = new Map();

        console.log('[FlowOrchestrator] ✅ Initialized (v3.2 - pagination support)');
    }

    /**
     * Load legacy miner modules
     * These miners return results WITHOUT writing to DB
     */
    async loadMiners() {
        if (this.miners) return this.miners;

        try {
            // Load legacy miner modules that return results (don't write to DB)
            const aiMiner = require('../../urlMiners/aiMiner');
            const playwrightTableMiner = require('../../urlMiners/playwrightTableMiner');
            const documentMiner = require('../../urlMiners/documentMiner');

            this.miners = {
                // Direct miners (return results, don't write to DB)
                aiMiner: {
                    name: 'aiMiner',
                    mine: async (job) => {
                        console.log(`[aiMiner] Starting for: ${job.input}`);
                        const result = await aiMiner.mine(job);
                        return this.normalizeResult(result, 'aiMiner');
                    }
                },

                playwrightTableMiner: {
                    name: 'playwrightTableMiner',
                    mine: async (job) => {
                        console.log(`[playwrightTableMiner] Starting for: ${job.input}`);
                        const result = await playwrightTableMiner.mine(job);
                        return this.normalizeResult(result, 'playwrightTableMiner');
                    }
                },


                // Document Miner: for flipbook platforms (FlipHTML5, Issuu, etc.)
                documentMiner: {
                    name: 'documentMiner',
                    mine: async (job) => {
                        console.log(`[documentMiner] Starting for: ${job.input}`);
                        const result = await documentMiner.mine(job.input);

                        // Normalize rawText to contacts (Rule #3: Only here)
                        // documentTextNormalizer handles chunking for large texts (>200K chars)
                        const normalized = documentTextNormalizer.normalize(result, job.input);

                        console.log(`[documentMiner] Normalized: ${normalized.contacts.length} contacts`);

                        const output = {
                            contacts: normalized.contacts,
                            extractionMethod: result.extractionMethod,
                            pageCount: result.pageCount,
                            source: 'documentMiner',
                            normalizationStats: normalized.stats
                        };

                        // Memory cleanup — release large text after normalization
                        result.extractedText = null;
                        result.textBlocks = null;

                        return output;
                    }
                },


                // Deterministic composite miner: runs playwrightTableMiner only
                // aiMiner is only added via execution plan when mode === 'ai'
                fullMiner: {
                    name: 'fullMiner',
                    mine: async (job) => {
                        console.log(`[fullMiner] Starting deterministic mining for: ${job.input}`);

                        try {
                            const tableResult = await playwrightTableMiner.mine(job);
                            const normalized = this.normalizeResult(tableResult, 'playwrightTableMiner');
                            console.log(`[fullMiner] playwrightTableMiner: ${tableResult?.emails?.length || 0} emails`);
                            return normalized;
                        } catch (err) {
                            console.warn(`[fullMiner] playwrightTableMiner failed: ${err.message}`);
                            return { status: 'FAILED', contacts: [], emails: [], error: err.message };
                        }
                    }
                }
            };

            // directoryMiner: try/catch load (Step 9 Phase 1)
            // Separate from main miners block so failure doesn't break other miners
            try {
                const { runDirectoryMiner } = require('../../urlMiners/directoryMiner');
                const { chromium } = require('playwright');

                this.miners.directoryMiner = {
                    name: 'directoryMiner',
                    mine: async (job) => {
                        console.log(`[directoryMiner] Starting for: ${job.input}`);
                        let browser = null;
                        try {
                            browser = await chromium.launch({ headless: true });
                            const page = await browser.newPage();
                            const rawCards = await runDirectoryMiner(page, job.input, job.config || {});
                            await browser.close();
                            browser = null;

                            // Convert raw cards to normalizeResult format (Step 9 Phase 3)
                            const cleanEmail = (e) => e ? e.replace(/\s+/g, '').trim() : null;
                            const contacts = rawCards.map(card => ({
                                company_name: card.company_name,
                                email: cleanEmail(card.email || (card.all_emails && card.all_emails[0]) || null),
                                phone: card.phone,
                                website: card.website,
                                country: card.country,
                                address: card.address,
                                contact_name: card.contact_name || card.contactName || null,
                                job_title: card.job_title || card.jobTitle || null
                            }));
                            const emails = rawCards
                                .flatMap(c => c.all_emails || (c.email ? [c.email] : []))
                                .filter(Boolean)
                                .map(e => e.replace(/\s+/g, '').trim())
                                .filter(e => e.includes('@') && e.length > 5);

                            console.log(`[directoryMiner] Result: ${contacts.length} contacts, ${emails.length} emails`);

                            return this.normalizeResult({ contacts, emails }, 'directoryMiner');
                        } catch (err) {
                            if (browser) await browser.close().catch(() => {});
                            throw err;
                        }
                    }
                };
                console.log('[FlowOrchestrator] directoryMiner loaded ✅');
            } catch (err) {
                console.log('[FlowOrchestrator] directoryMiner not available:', err.message);
            }

            // spaNetworkMiner: try/catch load (SPA catalog sites)
            // Separate from main miners block so failure doesn't break other miners
            // This miner manages its OWN browser lifecycle (ownBrowser: true)
            try {
                const { runSpaNetworkMiner } = require('../../urlMiners/spaNetworkMiner');
                const { chromium } = require('playwright');

                this.miners.spaNetworkMiner = {
                    name: 'spaNetworkMiner',
                    mine: async (job) => {
                        console.log(`[spaNetworkMiner] Starting for: ${job.input}`);
                        let browser = null;
                        try {
                            browser = await chromium.launch({ headless: true });
                            const page = await browser.newPage();
                            const rawCards = await runSpaNetworkMiner(page, job.input, job.config || {});
                            await browser.close();
                            browser = null;

                            // Convert raw cards to normalizeResult format
                            const contacts = rawCards.map(card => ({
                                company_name: card.company_name,
                                email: card.email || null,
                                phone: card.phone,
                                website: card.website,
                                country: card.country,
                                address: card.address,
                                city: card.city || null,
                                contact_name: card.contact_name || null,
                                job_title: card.job_title || null
                            }));
                            const emails = rawCards
                                .map(c => c.email)
                                .filter(e => e && typeof e === 'string' && e.includes('@') && e.length > 5);

                            console.log(`[spaNetworkMiner] Result: ${contacts.length} contacts, ${emails.length} emails`);

                            return this.normalizeResult({ contacts, emails }, 'spaNetworkMiner');
                        } catch (err) {
                            if (browser) await browser.close().catch(() => {});
                            throw err;
                        }
                    }
                };
                console.log('[FlowOrchestrator] spaNetworkMiner loaded ✅');
            } catch (err) {
                console.log('[FlowOrchestrator] spaNetworkMiner not available:', err.message);
            }

            // Aliases
            this.miners.playwrightMiner = this.miners.fullMiner;
            this.miners.playwrightDetailMiner = this.miners.fullMiner;
            this.miners.httpBasicMiner = this.miners.playwrightTableMiner;

            console.log('[FlowOrchestrator] Miners loaded:', Object.keys(this.miners).join(', '));
            return this.miners;

        } catch (err) {
            console.error('[FlowOrchestrator] Failed to load miners:', err.message);
            return null;
        }
    }

    /**
     * Normalize miner result to standard format
     *
     * v3.1.6 FIX: Handle both camelCase and snake_case field names
     * - aiMiner returns: companyName, contactName, jobTitle (camelCase)
     * - Some miners return: company_name, contact_name, job_title (snake_case)
     * - We now check both formats to ensure data is not lost
     */
    normalizeResult(result, source) {
        if (!result) {
            return { status: 'EMPTY', contacts: [], emails: [], source };
        }

        const contacts = [];

        // Extract emails
        const emails = result.emails || [];

        // Convert to UnifiedContact format
        if (result.contacts && Array.isArray(result.contacts)) {
            for (const c of result.contacts) {
                // v3.1.6: Extract fields with fallback for both naming conventions
                const companyName = c.company_name || c.companyName || c.company || null;
                const contactName = c.contact_name || c.contactName || c.name || null;
                const jobTitle = c.job_title || c.jobTitle || c.title || null;
                const email = c.email || c.emails?.[0] || null;

                // Debug: log incoming contact data with resolved values
                if (companyName || email) {
                    console.log(`[normalizeResult] ✅ ${companyName || 'Unknown'} - ${email || 'no email'} (source: ${source})`);
                }

                contacts.push(new UnifiedContact({
                    email: email,
                    contactName: contactName,
                    companyName: companyName,
                    jobTitle: jobTitle,
                    phone: c.phone || null,
                    website: c.website || null,
                    country: c.country || null,
                    city: c.city || null,
                    state: c.state || null,
                    address: c.address || null,
                    source: source,
                    confidence: c.confidence || 50
                }));
            }
        }

        // Also create contacts from raw emails (if no contacts)
        if (contacts.length === 0 && emails.length > 0) {
            for (const email of emails) {
                if (typeof email === 'string') {
                    contacts.push(new UnifiedContact({
                        email: email,
                        source: source,
                        confidence: 40
                    }));
                }
            }
        }

        return {
            status: contacts.length > 0 ? 'SUCCESS' : 'EMPTY',
            contacts,
            emails,
            source,
            meta: result.meta || {}
        };
    }

    /**
     * Merge multiple miner results
     */
    mergeResults(results) {
        const emailMap = new Map();
        let totalEmails = [];

        for (const result of results) {
            if (!result || !result.contacts) continue;

            totalEmails = totalEmails.concat(result.emails || []);

            for (const contact of result.contacts) {
                if (!contact.email) continue;

                const key = contact.email.toLowerCase();

                if (emailMap.has(key)) {
                    // Merge with existing
                    const existing = emailMap.get(key);
                    emailMap.set(key, UnifiedContact.merge(existing, contact));
                } else {
                    emailMap.set(key, contact);
                }
            }
        }

        const contacts = Array.from(emailMap.values());

        return {
            status: contacts.length > 0 ? 'SUCCESS' : 'EMPTY',
            contacts,
            emails: [...new Set(totalEmails)],
            source: 'merged'
        };
    }

    /**
     * Execute complete mining flow for a job
     * PDF Mimarisi: Flow 1 → (optional) Flow 2 → DB Write
     */
    async executeJob(job) {
        const jobId = job.id;
        const startTime = Date.now();

        console.log(`\n${'='.repeat(60)}`);
        console.log(`[FlowOrchestrator] Starting job ${jobId}`);
        console.log(`[FlowOrchestrator] URL: ${job.input}`);
        console.log(`${'='.repeat(60)}\n`);

        // Initialize job tracking
        this.activeJobs.set(jobId, {
            state: FLOW_STATE.PENDING,
            startTime,
            job
        });

        // Initialize cost tracking
        if (this.costTracker) {
            this.costTracker.initJob(jobId, job.organizer_id);
        }

        try {
            // ========================================
            // FLOW 1: Miners → Aggregator V1 → Redis
            // ========================================
            this.updateState(jobId, FLOW_STATE.FLOW1_RUNNING);

            const flow1Result = await this.executeFlow1(job);

            this.updateState(jobId, FLOW_STATE.FLOW1_COMPLETE);

            console.log(`[FlowOrchestrator] Flow 1 complete: ${flow1Result.contactCount} contacts`);
            console.log(`[FlowOrchestrator] Enrichment rate: ${(flow1Result.enrichmentRate * 100).toFixed(1)}%`);

            // ========================================
            // NO-REDIS FAST PATH: If Flow1 already persisted to DB, skip Flow2
            // ========================================
            if (flow1Result._alreadyPersisted) {
                this.updateState(jobId, FLOW_STATE.COMPLETED);
                const totalTime = Date.now() - startTime;
                let costSummary = null;
                if (this.costTracker) {
                    costSummary = this.costTracker.finalizeJob(jobId);
                }
                this.activeJobs.delete(jobId);

                // Block detection: 0 contacts + miner failures indicate possible block
                const blockDetected = flow1Result.contactCount === 0 && (flow1Result.hasBlockedMiner || flow1Result.allMinersFailed);

                console.log(`\n${'='.repeat(60)}`);
                console.log(`[FlowOrchestrator] Job ${jobId} COMPLETED (no-Redis path) in ${(totalTime/1000).toFixed(1)}s`);
                console.log(`[FlowOrchestrator] Contacts: ${flow1Result.contactCount}${blockDetected ? ' ⚠️ BLOCK DETECTED' : ''}`);
                console.log(`${'='.repeat(60)}\n`);

                return {
                    status: 'COMPLETED',
                    jobId,
                    totalTime,
                    flow1: {
                        contactCount: flow1Result.contactCount,
                        enrichmentRate: flow1Result.enrichmentRate,
                        pagination: flow1Result.paginationStats || null
                    },
                    flow2: { triggered: false },
                    cost: costSummary,
                    blockDetected
                };
            }

            // ========================================
            // FLOW 2: Deep Crawl (if needed)
            // ========================================
            let flow2Result = null;

            const flow2Decision = this.shouldTriggerFlow2(flow1Result);
            console.log(`[FlowOrchestrator] Flow 2 decision: trigger=${flow2Decision.trigger} — ${flow2Decision.reason}`);

            if (flow2Decision.trigger) {
                this.updateState(jobId, FLOW_STATE.FLOW2_RUNNING);

                flow2Result = await this.executeFlow2(job, flow1Result, {
                    maxWebsites: flow2Decision.maxWebsites || this.config.maxFlow2Websites,
                    concurrency: flow2Decision.concurrency || undefined,
                });

                this.updateState(jobId, FLOW_STATE.FLOW2_COMPLETE);

                console.log(`[FlowOrchestrator] Flow 2 complete: ${flow2Result?.savedCount || 0} saved`);
            } else {
                // No Flow 2 needed, Aggregator V2 writes Flow 1 results to DB
                console.log('[FlowOrchestrator] Flow 2 not needed, finalizing...');

                flow2Result = await this.aggregator.aggregateV2([], {
                    jobId,
                    organizerId: job.organizer_id,
                    sourceUrl: job.input
                });
            }

            // ========================================
            // FINALIZE
            // ========================================
            this.updateState(jobId, FLOW_STATE.COMPLETED);

            const totalTime = Date.now() - startTime;

            // Finalize cost tracking
            let costSummary = null;
            if (this.costTracker) {
                costSummary = this.costTracker.finalizeJob(jobId);
            }

            // Cleanup
            this.activeJobs.delete(jobId);

            // Block detection: 0 contacts + miner failures indicate possible block
            const blockDetected = flow1Result.contactCount === 0 && (flow1Result.hasBlockedMiner || flow1Result.allMinersFailed);

            const finalResult = {
                status: 'COMPLETED',
                jobId,
                totalTime,
                flow1: {
                    contactCount: flow1Result.contactCount,
                    enrichmentRate: flow1Result.enrichmentRate,
                    pagination: flow1Result.paginationStats || null
                },
                flow2: flow2Decision.trigger ? {
                    triggered: true,
                    reason: flow2Decision.reason,
                    savedCount: flow2Result?.savedCount || flow2Result?.stats?.saved || 0
                } : {
                    triggered: false,
                    reason: flow2Decision.reason
                },
                cost: costSummary,
                blockDetected
            };

            console.log(`\n${'='.repeat(60)}`);
            console.log(`[FlowOrchestrator] Job ${jobId} COMPLETED in ${(totalTime/1000).toFixed(1)}s`);
            console.log(`[FlowOrchestrator] Final: ${flow2Result?.savedCount || flow2Result?.stats?.saved || flow1Result.contactCount} contacts saved`);
            console.log(`${'='.repeat(60)}\n`);

            return finalResult;

        } catch (err) {
            console.error(`[FlowOrchestrator] Job ${jobId} FAILED:`, err.message);

            this.updateState(jobId, FLOW_STATE.FAILED);

            // Cleanup
            this.activeJobs.delete(jobId);
            if (this.costTracker) {
                this.costTracker.finalizeJob(jobId);
            }

            // Clear temp storage
            if (this.storage) {
                await this.storage.clearFlowResults(jobId);
            }

            // Publish failure event
            if (this.eventBus) {
                await this.eventBus.publish(CHANNELS.JOB_FAILED, {
                    jobId,
                    error: err.message
                });
            }

            return {
                status: 'FAILED',
                jobId,
                error: err.message,
                totalTime: Date.now() - startTime,
                blockDetected: err.message?.includes('BLOCK') || false
            };
        }
    }

    /**
     * Detect if a job URL is paginated and return pagination info.
     * Uses PageAnalyzer results + SmartRouter hints + page 1 HTML detection.
     *
     * @param {Object} job - Mining job
     * @param {Object} routeDecision - SmartRouter decision (optional)
     * @returns {Promise<{isPaginated: boolean, totalPages: number, pageUrls: string[]}>}
     */
    async detectPagination(job, routeDecision = null) {
        if (!this.config.enablePagination) {
            return { isPaginated: false, totalPages: 1, pageUrls: [job.input] };
        }

        const maxPages = job.config?.max_pages || this.config.maxPages;

        // Check SmartRouter hints first
        const hints = routeDecision?.hints || {};
        const paginationType = routeDecision?.paginationType || null;
        const hasPaginationHint = hints.pagination?.detected || false;

        // Also check if the URL itself has a page param (strong signal)
        const urlHasPageParam = /[?&]page=\d+/i.test(job.input) || /\/page\/\d+/i.test(job.input);

        if (!hasPaginationHint && !urlHasPageParam) {
            return { isPaginated: false, totalPages: 1, pageUrls: [job.input] };
        }

        console.log(`[Pagination] Detected pagination signal (hint: ${hasPaginationHint}, urlParam: ${urlHasPageParam})`);

        // Fetch page 1 to detect total pages
        let page1Html = null;
        try {
            const result = await fetchPage(job.input);
            if (!result.blocked && result.html) {
                page1Html = result.html;
            }
        } catch (err) {
            console.warn(`[Pagination] Could not fetch page 1 for detection: ${err.message}`);
        }

        let totalDetected = 1;
        if (page1Html) {
            totalDetected = detectTotalPages(page1Html, job.input);
        }

        // If URL has page param but detection found 1, use a reasonable default scan
        if (totalDetected <= 1 && urlHasPageParam) {
            totalDetected = 5; // Conservative default for URL-signaled pagination
            console.log(`[Pagination] URL has page param but could not detect total, using default: ${totalDetected}`);
        }

        const totalPages = Math.min(totalDetected, maxPages);

        if (totalPages <= 1) {
            return { isPaginated: false, totalPages: 1, pageUrls: [job.input] };
        }

        // Build URLs for all pages
        const pageUrls = [];
        for (let i = 1; i <= totalPages; i++) {
            pageUrls.push(buildPageUrl(job.input, i));
        }

        console.log(`[Pagination] Will mine ${totalPages} pages (detected: ${totalDetected}, max: ${maxPages})`);

        return { isPaginated: true, totalPages, pageUrls };
    }

    /**
     * Mine a single page URL with the given miner.
     * Returns normalized miner result.
     *
     * @param {Object} miner - Miner instance
     * @param {Object} job - Original job (will be cloned with modified input)
     * @param {string} pageUrl - URL for this specific page
     * @param {number} pageNum - Page number (for logging)
     * @returns {Promise<Object>} Miner result
     */
    async mineSinglePage(miner, job, pageUrl, pageNum) {
        // Create a shallow copy of the job with the page URL
        const pageJob = { ...job, input: pageUrl };

        try {
            const result = await miner.mine(pageJob);

            const contactCount = result.contacts?.length || 0;
            const emailCount = result.emails?.length || 0;
            console.log(`[Pagination] Page ${pageNum}: ${contactCount} contacts, ${emailCount} emails`);

            if (this.circuitBreaker && result.status !== 'BLOCKED') {
                this.circuitBreaker.recordSuccess(pageUrl);
            }

            return result;
        } catch (err) {
            console.error(`[Pagination] Page ${pageNum} failed: ${err.message}`);

            if (this.circuitBreaker) {
                this.circuitBreaker.recordFailure(pageUrl, err.message);
            }

            return { status: 'FAILED', contacts: [], emails: [], error: err.message };
        }
    }

    /**
     * Mine all pages of a paginated site and return merged results.
     *
     * @param {Object} miner - Miner to use
     * @param {Object} job - Mining job
     * @param {string[]} pageUrls - URLs for each page
     * @returns {Promise<Object>} Merged result from all pages
     */
    async mineAllPages(miner, job, pageUrls) {
        const allResults = [];
        const seenHashes = new Set();
        const delayMs = job.config?.list_page_delay_ms || this.config.pageDelayMs;
        let consecutiveDuplicates = 0;
        let consecutiveEmpty = 0;

        console.log(`[Pagination] Mining ${pageUrls.length} pages (delay: ${delayMs}ms)`);

        for (let i = 0; i < pageUrls.length; i++) {
            const pageNum = i + 1;
            const pageUrl = pageUrls[i];

            console.log(`[Pagination] --- Page ${pageNum}/${pageUrls.length}: ${pageUrl}`);

            const result = await this.mineSinglePage(miner, job, pageUrl, pageNum);

            // Check for empty result
            if (!result.contacts || result.contacts.length === 0) {
                consecutiveEmpty++;
                console.log(`[Pagination] Page ${pageNum}: empty (consecutive: ${consecutiveEmpty})`);

                if (consecutiveEmpty >= 3) {
                    console.log(`[Pagination] Stopping: 3 consecutive empty pages`);
                    break;
                }

                // Still delay before next page
                if (i < pageUrls.length - 1) {
                    await this.sleep(delayMs);
                }
                continue;
            }

            consecutiveEmpty = 0; // Reset empty counter

            // Duplicate content detection
            const hash = createContentHash(result.contacts);
            if (seenHashes.has(hash)) {
                consecutiveDuplicates++;
                console.log(`[Pagination] Page ${pageNum}: duplicate content (consecutive: ${consecutiveDuplicates})`);

                if (consecutiveDuplicates >= 2) {
                    console.log(`[Pagination] Stopping: 2 consecutive duplicate pages`);
                    break;
                }
            } else {
                consecutiveDuplicates = 0;
                seenHashes.add(hash);
                allResults.push(result);
            }

            // Delay between pages (polite crawling)
            if (i < pageUrls.length - 1) {
                await this.sleep(delayMs);
            }
        }

        console.log(`[Pagination] Completed: ${allResults.length} unique pages mined`);

        // Merge all page results
        if (allResults.length === 0) {
            return { status: 'EMPTY', contacts: [], emails: [], source: 'pagination' };
        }

        if (allResults.length === 1) {
            return allResults[0];
        }

        return this.mergeResults(allResults);
    }

    /**
     * Sleep helper for delays between pages.
     * @param {number} ms
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Execute Flow 1: Miners → Aggregator V1 → Redis
     * DOES NOT WRITE TO DB!
     *
     * v3.2: Now supports pagination — detects paginated sites and
     * iterates through all pages before aggregating.
     */
    async executeFlow1(job) {
        const jobId = job.id;

        // Load miners
        const miners = await this.loadMiners();
        if (!miners) {
            throw new Error('Failed to load miners');
        }

        const miningMode = job.config?.mining_mode;
        console.log('[DEBUG][FLOW1] mining_mode =', miningMode);

        // Free/Full mode: build and run an execution plan when available.
        // 'full' = legacy name for free mode, 'free' = new name from UI
        if ((miningMode === 'full' || miningMode === 'free') && typeof buildExecutionPlan === 'function') {
            console.log(`[Flow1] ${miningMode} mode: building execution plan...`);

            const analyzer = getPageAnalyzer();
            let analysis = null;

            try {
                analysis = await analyzer.analyze(job.input);
            } catch (err) {
                console.warn(`[Flow1] PageAnalyzer failed: ${err.message}`);
            }

            if (analysis) {
                let inputType = 'unknown';

                if (analysis.pageType === PAGE_TYPES.DIRECTORY) {
                    inputType = 'directory';
                } else if (analysis.pageType === PAGE_TYPES.SPA_CATALOG) {
                    inputType = 'spa_catalog';
                } else if (analysis.pageType === PAGE_TYPES.DOCUMENT_VIEWER) {
                    inputType = 'document';
                } else if (analysis.pageType === PAGE_TYPES.EXHIBITOR_TABLE || analysis.pageType === 'website') {
                    inputType = 'website';
                }

                let executionPlan = [];

                try {
                    executionPlan = buildExecutionPlan({ inputType, miningMode: miningMode || 'full', analysis });
                } catch (err) {
                    console.warn(`[Flow1] Execution plan build failed: ${err.message}`);
                }

                const executablePlan = Array.isArray(executionPlan)
                    ? executionPlan.filter((step) => step?.miner && miners[step.miner])
                    : [];

                if (executablePlan.length > 0) {
                    console.log(`[Flow1] Execution plan: ${executablePlan.map((step) => step.miner).join(' → ')}`);

                    if (this.circuitBreaker) {
                        const canRequest = this.circuitBreaker.canRequest(job.input);
                        if (!canRequest.allowed) {
                            console.warn(`[Flow1] Circuit breaker: ${canRequest.reason}`);
                        }
                    }

                    // --- Pagination detection for execution plan path ---
                    // GUARD: directoryMiner handles its own pagination internally
                    // (crawlListPages, max 10 pages). Running flowOrchestrator pagination
                    // on top would cause N × M crawls (e.g. 15 × 10 = 150). Skip external.
                    const primaryStepMiner = executablePlan[0]?.miner;
                    const skipExternalPagination = (
                        primaryStepMiner === 'directoryMiner' || inputType === 'directory' ||
                        primaryStepMiner === 'spaNetworkMiner' || inputType === 'spa_catalog'
                    );
                    const paginationInfo = skipExternalPagination
                        ? { isPaginated: false, totalPages: 1, pageUrls: [job.input] }
                        : await this.detectPagination(job, {
                            paginationType: analysis.paginationType,
                            hints: { pagination: { detected: analysis.paginationType !== PAGINATION_TYPES.NONE } }
                        });

                    const minerResults = [];

                    if (paginationInfo.isPaginated) {
                        console.log(`[Flow1] Paginated execution plan: ${paginationInfo.totalPages} pages`);

                        // For paginated sites with execution plan, run primary miner across all pages
                        const primaryStep = executablePlan[0];
                        const primaryMiner = miners[primaryStep.miner];

                        const paginatedResult = await this.mineAllPages(primaryMiner, job, paginationInfo.pageUrls);

                        if (primaryStep.normalizer === 'documentTextNormalizer') {
                            const normalized = documentTextNormalizer.normalize(paginatedResult, job.input);
                            paginatedResult.contacts = normalized.contacts || [];
                            paginatedResult.emails = (normalized.contacts || []).map(c => c.email).filter(Boolean);
                            if (normalized.stats) paginatedResult.normalizationStats = normalized.stats;
                        }

                        minerResults.push(paginatedResult);

                        // Run remaining miners on page 1 only (for enrichment)
                        for (let i = 1; i < executablePlan.length; i++) {
                            const step = executablePlan[i];
                            const miner = miners[step.miner];
                            console.log(`[Flow1] Enrichment miner (page 1 only): ${step.miner}`);

                            let minerResult;
                            try {
                                minerResult = await miner.mine(job);
                                if (this.circuitBreaker && minerResult.status !== 'BLOCKED') {
                                    this.circuitBreaker.recordSuccess(job.input);
                                }
                            } catch (err) {
                                console.error(`[Flow1] Enrichment miner failed: ${err.message}`);
                                minerResult = { status: 'FAILED', contacts: [], emails: [], error: err.message };
                            }

                            if (step.normalizer === 'documentTextNormalizer') {
                                const normalized = documentTextNormalizer.normalize(minerResult, job.input);
                                minerResult.contacts = normalized.contacts || [];
                                minerResult.emails = (normalized.contacts || []).map(c => c.email).filter(Boolean);
                                if (normalized.stats) minerResult.normalizationStats = normalized.stats;
                            }

                            minerResults.push(minerResult);
                        }
                    } else {
                        // No pagination — original behavior
                        for (const step of executablePlan) {
                            const miner = miners[step.miner];

                            console.log(`[Flow1] Step 2: Mining with ${step.miner}...`);

                            let minerResult;

                            try {
                                minerResult = await miner.mine(job);

                                console.log(`[Flow1] Miner result: ${minerResult.contacts?.length || 0} contacts, ${minerResult.emails?.length || 0} emails`);

                                if (this.circuitBreaker && minerResult.status !== 'BLOCKED') {
                                    this.circuitBreaker.recordSuccess(job.input);
                                }
                            } catch (err) {
                                console.error(`[Flow1] Miner failed: ${err.message}`);

                                if (this.circuitBreaker) {
                                    this.circuitBreaker.recordFailure(job.input, err.message);
                                }

                                minerResult = { status: 'FAILED', contacts: [], emails: [], error: err.message };
                            }

                            if (step.normalizer === 'documentTextNormalizer') {
                                const normalized = documentTextNormalizer.normalize(minerResult, job.input);

                                // contacts (yeni sistem)
                                minerResult.contacts = normalized.contacts || [];

                                // Legacy Aggregator uyumu icin
                                minerResult.emails = (normalized.contacts || [])
                                    .map(c => c.email)
                                    .filter(Boolean);

                                if (normalized.stats) {
                                    minerResult.normalizationStats = normalized.stats;
                                }
                            }

                            console.log(`[Flow1] Executed ${step.miner} (normalizer: ${step.normalizer})`);

                            minerResults.push(minerResult);
                        }
                    }

                    console.log('[Flow1] Step 3: Aggregating (V1 → Redis)...');

                    const aggregationResult = await this.aggregator.aggregateV1(
                        minerResults,
                        {
                            jobId,
                            organizerId: job.organizer_id,
                            sourceUrl: job.input
                        }
                    );

                    // Block detection: check miner results for BLOCKED/FAILED statuses
                    const hasBlockedMiner = minerResults.some(r => r.status === 'BLOCKED');
                    const allMinersFailed = minerResults.length > 0 && minerResults.every(r => r.status === 'FAILED' || r.status === 'BLOCKED' || r.status === 'EMPTY');

                    return {
                        contactCount: aggregationResult.contactCount,
                        enrichmentRate: aggregationResult.enrichmentRate,
                        websiteUrls: (aggregationResult.websiteUrlCount > 0 && this.storage?.enabled) ?
                            (await this.storage.getFlowResults(jobId))?.websiteUrls || [] : [],
                        minerStats: aggregationResult.minerStats,
                        paginationStats: paginationInfo.isPaginated ? {
                            totalPages: paginationInfo.totalPages,
                            pageUrls: paginationInfo.pageUrls.length
                        } : null,
                        hasBlockedMiner,
                        allMinersFailed
                    };
                }
            }

            console.log('[Flow1] Execution plan unavailable, falling back to single miner...');
        }

        // 1. Route the job (determine which miner to use)
        console.log('[Flow1] Step 1: Routing...');
        const routeDecision = await this.router.routeJob(job);

        const selectedMiner = routeDecision.primaryMiner;
        console.log(`[Flow1] Route decision: ${selectedMiner}`);

        // 2. Check circuit breaker
        if (this.circuitBreaker) {
            const canRequest = this.circuitBreaker.canRequest(job.input);
            if (!canRequest.allowed) {
                console.warn(`[Flow1] Circuit breaker: ${canRequest.reason}`);
                // Continue anyway, might recover
            }
        }

        // 3. Detect pagination
        // GUARD: directoryMiner and spaNetworkMiner handle their own data fetching — skip external pagination
        const skipPagination = (
            selectedMiner === 'directoryMiner' || routeDecision.pageType === PAGE_TYPES.DIRECTORY ||
            selectedMiner === 'spaNetworkMiner' || routeDecision.pageType === PAGE_TYPES.SPA_CATALOG
        );
        const paginationInfo = skipPagination
            ? { isPaginated: false, totalPages: 1, pageUrls: [job.input] }
            : await this.detectPagination(job, routeDecision);

        // 4. Execute miner (single page or paginated)
        const miner = miners[selectedMiner] || miners.fullMiner;
        let minerResult;

        if (paginationInfo.isPaginated) {
            // PAGINATED: Mine all pages
            console.log(`[Flow1] Step 2: Paginated mining with ${selectedMiner} (${paginationInfo.totalPages} pages)...`);
            minerResult = await this.mineAllPages(miner, job, paginationInfo.pageUrls);
        } else {
            // SINGLE PAGE: Original behavior
            console.log(`[Flow1] Step 2: Mining with ${selectedMiner}...`);

            try {
                minerResult = await miner.mine(job);

                console.log(`[Flow1] Miner result: ${minerResult.contacts?.length || 0} contacts, ${minerResult.emails?.length || 0} emails`);

                // Record success in circuit breaker
                if (this.circuitBreaker && minerResult.status !== 'BLOCKED') {
                    this.circuitBreaker.recordSuccess(job.input);
                }

            } catch (err) {
                console.error(`[Flow1] Miner failed: ${err.message}`);

                // Record failure in circuit breaker
                if (this.circuitBreaker) {
                    this.circuitBreaker.recordFailure(job.input, err.message);
                }

                minerResult = { status: 'FAILED', contacts: [], emails: [], error: err.message };
            }
        }

        // 5. Aggregate V1 (save to Redis, NOT DB!)
        console.log('[Flow1] Step 3: Aggregating (V1 → Redis)...');

        const aggregationResult = await this.aggregator.aggregateV1(
            [minerResult],
            {
                jobId,
                organizerId: job.organizer_id,
                sourceUrl: job.input
            }
        );

        // Block detection for SmartRouter path
        const hasBlockedMiner = minerResult.status === 'BLOCKED';
        const allMinersFailed = minerResult.status === 'FAILED' || minerResult.status === 'BLOCKED' || minerResult.status === 'EMPTY';

        return {
            contactCount: aggregationResult.contactCount,
            enrichmentRate: aggregationResult.enrichmentRate,
            websiteUrls: aggregationResult.websiteUrlCount > 0 ?
                (await this.storage.getFlowResults(jobId))?.websiteUrls : [],
            minerStats: aggregationResult.minerStats,
            paginationStats: paginationInfo.isPaginated ? {
                totalPages: paginationInfo.totalPages,
                pageUrls: paginationInfo.pageUrls.length
            } : null,
            hasBlockedMiner,
            allMinersFailed
        };
    }

    /**
     * Execute Flow 2: WebsiteScraper → Aggregator V2 → DB
     * @param {Object} limits - Optional OOM protection limits { maxWebsites, concurrency }
     */
    async executeFlow2(job, flow1Result, limits = {}) {
        const jobId = job.id;
        const maxWebsites = limits.maxWebsites || this.config.maxFlow2Websites;

        // Get website URLs from Flow 1 (with OOM-safe limit)
        const websiteUrls = (flow1Result.websiteUrls || [])
            .slice(0, maxWebsites);

        if (limits.maxWebsites || limits.concurrency) {
            console.log(`[Flow2] OOM protection active: max ${maxWebsites} URLs, concurrency ${limits.concurrency || 'default'}`);
        }

        if (websiteUrls.length === 0) {
            console.log('[Flow2] No website URLs to scrape');

            // Just finalize Flow 1 results to DB
            return this.aggregator.aggregateV2([], {
                jobId,
                organizerId: job.organizer_id,
                sourceUrl: job.input
            });
        }

        console.log(`[Flow2] Scraping ${websiteUrls.length} websites...`);

        // Scrape websites (simplified for now)
        const scraperResults = [];

        // TODO: Implement actual website scraping
        // For now, just finalize Flow 1 results

        // Aggregate V2 (final merge + DB write)
        console.log('[Flow2] Aggregating V2 (final merge → DB)...');

        const finalResult = await this.aggregator.aggregateV2(scraperResults, {
            jobId,
            organizerId: job.organizer_id,
            sourceUrl: job.input
        });

        return finalResult;
    }

    /**
     * Check if Flow 2 should be triggered
     * Returns { trigger, maxWebsites?, concurrency?, reason }
     *
     * OOM Protection Rules:
     *   - Contact > 500 AND enrichment >= 50% → SKIP Flow 2
     *   - Contact > 500 AND enrichment < 50% → Limited Flow 2 (max 50 URLs, concurrency 1)
     *   - Contact <= 500 → Normal Flow 2 (existing behavior)
     */
    shouldTriggerFlow2(flow1Result) {
        if (!this.config.enableFlow2) {
            return { trigger: false, reason: 'Flow 2 disabled in config' };
        }

        const contactCount = flow1Result.contactCount || 0;
        const enrichmentRate = flow1Result.enrichmentRate || 0;
        const enrichPct = (enrichmentRate * 100).toFixed(0);

        // === OOM PROTECTION: Large dataset rules ===
        if (contactCount > 500) {
            if (enrichmentRate >= 0.5) {
                // Rule 1: Large dataset + good enrichment → skip
                return {
                    trigger: false,
                    reason: `OOM protection: ${contactCount} contacts with ${enrichPct}% enrichment — skipping Flow 2`
                };
            } else {
                // Rule 2: Large dataset + low enrichment → limited Flow 2
                return {
                    trigger: true,
                    maxWebsites: 50,
                    concurrency: 1,
                    reason: `OOM protection: ${contactCount} contacts with ${enrichPct}% enrichment — limited Flow 2 (max 50 URLs, concurrency 1)`
                };
            }
        }

        // === Normal dataset (≤ 500 contacts) — existing logic ===
        if (enrichmentRate < this.config.flow2Threshold) {
            return {
                trigger: true,
                reason: `Enrichment ${enrichPct}% < threshold ${this.config.flow2Threshold * 100}%`
            };
        }

        if (flow1Result.websiteUrls?.length > 0 && contactCount < 10) {
            return {
                trigger: true,
                reason: `Websites found with few contacts (${contactCount})`
            };
        }

        return { trigger: false, reason: `Enrichment sufficient (${enrichPct}%)` };
    }

    /**
     * Update job state
     */
    updateState(jobId, state) {
        const jobInfo = this.activeJobs.get(jobId);
        if (jobInfo) {
            jobInfo.state = state;
            jobInfo.stateUpdatedAt = Date.now();
        }
    }

    /**
     * Get job state
     */
    getJobState(jobId) {
        return this.activeJobs.get(jobId);
    }

    /**
     * Get all active jobs
     */
    getActiveJobs() {
        return Array.from(this.activeJobs.entries()).map(([id, info]) => ({
            jobId: id,
            state: info.state,
            startTime: info.startTime,
            elapsed: Date.now() - info.startTime
        }));
    }
}

// Factory
function createFlowOrchestrator(db, config = {}) {
    return new FlowOrchestrator(db, config);
}

module.exports = {
    FlowOrchestrator,
    createFlowOrchestrator,
    FLOW_STATE,
    DEFAULT_CONFIG
};
