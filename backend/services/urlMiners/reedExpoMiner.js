/**
 * LIFFY ReedExpo Miner v1.1
 * ==========================
 *
 * Generic miner for all ReedExpo platform exhibitor directories.
 * Works with any ReedExpo-powered trade show site:
 *   - mcexpocomfort.it, arabhealth.com, bigshowafrica.com
 *   - wtm.com, ishhvac.com, ... any ReedExpo platform site
 *
 * Two-phase pipeline:
 *   1. Infinite scroll (Playwright) — scroll list page, collect detail URLs + org GUIDs
 *      Auto-detects eventEditionId from __NEXT_DATA__ / scripts / network
 *      Auto-detects x-clientid from network requests (fallback: hardcoded)
 *   2. GraphQL API (axios) — batch query ReedExpo GraphQL for contactEmail/website/phone
 *      Concurrency 20, 10s timeout per request.
 *
 * Miner contract:
 *   - Returns raw card data only (no normalization, no DB writes)
 *   - Browser lifecycle managed by flowOrchestrator wrapper
 *   - Handles its own pagination internally (ownPagination: true, ownBrowser: true)
 */

const axios = require('axios');

// ─── Constants ───────────────────────────────────────────────────────

const GRAPHQL_URL = 'https://api.reedexpo.com/graphql/';
const DEFAULT_CLIENT_ID = 'uhQVcmxLwXAjVtVpTvoerERiZSsNz0om';

// Pattern: exhib_profile.COMPANY_NAME.org-GUID.html → extract "org-GUID"
const ORG_GUID_REGEX = /exhib_profile\.[^.]+\.(org-[a-f0-9\-]+)\.html/i;

// Pattern: eventEditionId (eve-UUID format)
const EVE_ID_REGEX = /(eve-[a-f0-9\-]{36})/i;

// Known ReedExpo platform hostnames
const REED_EXPO_HOSTNAMES = [
    'mcexpocomfort.it',
    'arabhealth.com',
    'bigshowafrica.com',
    'wtm.com',
    'worldtravelmarket.com',
    'ishhvac.com'
];

const JUNK_EMAIL_DOMAINS = [
    'example.com', 'example.org', 'test.com', 'sentry.io',
    'wix.com', 'wordpress.com', 'squarespace.com',
    'googleapis.com', 'googleusercontent.com', 'gstatic.com',
    'w3.org', 'schema.org', 'facebook.com', 'twitter.com',
    'instagram.com', 'youtube.com', 'linkedin.com',
    'reedexpo.com', 'rxglobal.com'
];

const DEFAULT_MAX_SCROLLS = 50;
const DEFAULT_SCROLL_DELAY_MS = 2000;
const DEFAULT_MAX_DETAILS = 2000;
const DEFAULT_TOTAL_TIMEOUT = 300000; // 5 minutes
const DEFAULT_CONCURRENCY = 20;
const DEFAULT_REQUEST_TIMEOUT = 10000; // 10s per request

// ─── canHandle — Static URL Check ───────────────────────────────────

/**
 * Check if a URL belongs to a ReedExpo platform site.
 * Can be called without a browser — pure URL/string check.
 * @param {string} url - URL to check
 * @param {string} [pageSource] - Optional page HTML source for deeper check
 * @returns {boolean}
 */
function canHandle(url, pageSource) {
    try {
        const hostname = new URL(url).hostname.toLowerCase();

        // Known ReedExpo hostnames
        if (REED_EXPO_HOSTNAMES.some(d => hostname.includes(d))) return true;

        // reedexpo.com in hostname (subdomains, etc.)
        if (hostname.includes('reedexpo.com')) return true;
    } catch (e) {
        // Invalid URL
    }

    // Check page source for ReedExpo API references
    if (pageSource && typeof pageSource === 'string') {
        if (pageSource.includes('api.reedexpo.com')) return true;
    }

    return false;
}

// ─── Phase 1: Infinite Scroll — Collect Links + Auto-Detect Config ──

/**
 * Auto-detect eventEditionId from page content and network requests.
 * Tries structured __NEXT_DATA__ paths first, then regex fallbacks.
 */
async function detectEventEditionId(page, capturedEveIds) {
    // 1. Try __NEXT_DATA__ — structured JSON paths
    const fromNextData = await page.evaluate(() => {
        const nextEl = document.getElementById('__NEXT_DATA__');
        if (!nextEl) return null;
        try {
            const data = JSON.parse(nextEl.textContent);
            const pp = data?.props?.pageProps;
            if (!pp) return null;

            // Try known paths
            if (pp.eventEditionId) return pp.eventEditionId;
            if (pp.eventEdition?.id) return pp.eventEdition.id;
            if (pp.event?.eventEditionId) return pp.event.eventEditionId;
            if (pp.config?.eventEditionId) return pp.config.eventEditionId;
            if (pp.initialState?.eventEditionId) return pp.initialState.eventEditionId;

            // Fallback: regex on full __NEXT_DATA__ text
            const text = nextEl.textContent;
            const match = text.match(/(eve-[a-f0-9\-]{36})/i);
            return match ? match[1] : null;
        } catch (e) {
            return null;
        }
    });

    if (fromNextData) {
        console.log(`[reedExpoMiner] eventEditionId from __NEXT_DATA__: ${fromNextData}`);
        return fromNextData;
    }

    // 2. Try script tag scan
    const fromScripts = await page.evaluate(() => {
        const scripts = [...document.querySelectorAll('script')];
        for (const s of scripts) {
            const text = s.textContent || '';
            const match = text.match(/(eve-[a-f0-9\-]{36})/i);
            if (match) return match[1];
        }
        return null;
    });

    if (fromScripts) {
        console.log(`[reedExpoMiner] eventEditionId from script tags: ${fromScripts}`);
        return fromScripts;
    }

    // 3. Try captured network requests
    if (capturedEveIds.length > 0) {
        console.log(`[reedExpoMiner] eventEditionId from network: ${capturedEveIds[0]}`);
        return capturedEveIds[0];
    }

    // 4. Full HTML regex as last resort
    const fromHtml = await page.evaluate(() => {
        const html = document.documentElement.outerHTML;
        const match = html.match(/(eve-[a-f0-9\-]{36})/i);
        return match ? match[1] : null;
    });

    if (fromHtml) {
        console.log(`[reedExpoMiner] eventEditionId from HTML: ${fromHtml}`);
        return fromHtml;
    }

    return null;
}

/**
 * Auto-detect x-clientid from captured network requests to api.reedexpo.com.
 */
function detectClientId(capturedClientIds) {
    if (capturedClientIds.length > 0) {
        console.log(`[reedExpoMiner] x-clientid from network: ${capturedClientIds[0]}`);
        return capturedClientIds[0];
    }
    console.log(`[reedExpoMiner] x-clientid fallback: ${DEFAULT_CLIENT_ID}`);
    return DEFAULT_CLIENT_ID;
}

/**
 * Scroll the page to the bottom repeatedly until no new content loads.
 * Captures eventEditionId and x-clientid from network requests.
 * Returns { cards, eventEditionId, clientId }.
 */
async function collectExhibitorLinks(page, url, config) {
    const maxScrolls = config.max_scrolls || DEFAULT_MAX_SCROLLS;
    const scrollDelay = config.scroll_delay_ms || DEFAULT_SCROLL_DELAY_MS;
    const startTime = Date.now();

    // Capture eventEditionId and x-clientid from network requests
    const capturedEveIds = [];
    const capturedClientIds = [];

    const onRequest = (req) => {
        const reqUrl = req.url();
        const headers = req.headers();

        // Capture eve-xxx from any request URL
        const eveMatch = reqUrl.match(EVE_ID_REGEX);
        if (eveMatch && !capturedEveIds.includes(eveMatch[1])) {
            capturedEveIds.push(eveMatch[1]);
        }

        // Capture x-clientid from requests to reedexpo API
        if (reqUrl.includes('reedexpo.com') || reqUrl.includes('reedexpo')) {
            const clientId = headers['x-clientid'] || headers['X-ClientId'] || headers['x-ClientId'];
            if (clientId && !capturedClientIds.includes(clientId)) {
                capturedClientIds.push(clientId);
            }
        }
    };
    page.on('request', onRequest);

    console.log(`[reedExpoMiner] Phase 1: Navigating to ${url}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log(`[reedExpoMiner] Phase 1: Page loaded (${Date.now() - startTime}ms)`);

    try {
        await page.waitForSelector('a[href*="exhib_profile"]', { timeout: 10000 });
        console.log(`[reedExpoMiner] Phase 1: Exhibitor links detected in DOM`);
    } catch (e) {
        console.log(`[reedExpoMiner] Phase 1: No exhibitor links after 10s, waiting 3s for JS render...`);
        await page.waitForTimeout(3000);
    }

    await page.waitForTimeout(3000);

    // Detect eventEditionId and clientId while page is loaded
    const eventEditionId = await detectEventEditionId(page, capturedEveIds);
    const clientId = detectClientId(capturedClientIds);

    // Remove network listener before scrolling (performance)
    page.removeListener('request', onRequest);

    console.log(`[reedExpoMiner] Phase 1: Ready to scroll (${Date.now() - startTime}ms), eventEditionId: ${eventEditionId || 'NOT FOUND'}, clientId: ${clientId}`);

    let previousHeight = await page.evaluate(() => document.body.scrollHeight);
    let noChangeCount = 0;
    let scrollCount = 0;

    console.log(`[reedExpoMiner] Phase 1: Starting infinite scroll (max ${maxScrolls}, initial height=${previousHeight})`);

    while (scrollCount < maxScrolls && noChangeCount < 3) {
        scrollCount++;
        const shouldLog = scrollCount <= 5 || scrollCount % 10 === 0;

        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(scrollDelay);

        const currentHeight = await page.evaluate(() => document.body.scrollHeight);

        if (currentHeight === previousHeight) {
            noChangeCount++;
        } else {
            noChangeCount = 0;
        }

        previousHeight = currentHeight;

        if (shouldLog) {
            const linkCount = await page.evaluate(() =>
                document.querySelectorAll('a[href*="exhib_profile"]').length
            );
            console.log(`[reedExpoMiner] Scroll ${scrollCount}/${maxScrolls}: ${linkCount} links, height=${currentHeight}, noChange=${noChangeCount}`);
        }

        if (Date.now() - startTime > 150000) {
            console.log(`[reedExpoMiner] Phase 1 timeout (150s) — stopping scroll`);
            break;
        }
    }

    console.log(`[reedExpoMiner] Scrolling done after ${scrollCount} scrolls (noChange=${noChangeCount}, ${Date.now() - startTime}ms)`);

    const cardData = await page.evaluate(() => {
        const cards = [];
        const anchors = document.querySelectorAll('a[href*="exhib_profile"]');
        const seen = new Set();

        for (const a of anchors) {
            const href = a.getAttribute('href');
            if (!href) continue;

            let fullUrl;
            try {
                fullUrl = new URL(href, window.location.origin).href;
            } catch (e) { continue; }

            if (seen.has(fullUrl)) continue;
            seen.add(fullUrl);

            const card = a.closest('[class*="card"], [class*="exhibitor"], [class*="item"], li, article') || a;
            const nameEl = card.querySelector('h2, h3, h4, .title, [class*="name"], [class*="title"]');
            const companyName = nameEl
                ? nameEl.textContent.trim()
                : a.textContent.trim().split('\n')[0].trim();

            const metaEl = card.querySelector('[class*="country"], [class*="location"], [class*="stand"], small, .meta');
            const meta = metaEl ? metaEl.textContent.trim() : null;

            cards.push({
                detail_url: fullUrl,
                company_name: companyName || null,
                country: meta || null
            });
        }

        return cards;
    });

    // Extract organisationGuid from each detail URL
    for (const card of cardData) {
        const match = card.detail_url.match(ORG_GUID_REGEX);
        card.org_guid = match ? match[1] : null;
    }

    const withGuid = cardData.filter(c => c.org_guid).length;
    console.log(`[reedExpoMiner] Phase 1 complete: ${cardData.length} exhibitors, ${withGuid} with GUID`);

    return { cards: cardData, eventEditionId, clientId };
}

// ─── Phase 2: GraphQL API — Email Extraction ────────────────────────

/**
 * Query ReedExpo GraphQL for a single organisation.
 */
async function queryGraphQL(orgGuid, eventEditionId, clientId, requestTimeout) {
    try {
        const res = await axios.post(GRAPHQL_URL, {
            query: `{ exhibitingOrganisation(eventEditionId:"${eventEditionId}", organisationId:"${orgGuid}") { companyName contactEmail website phone } }`
        }, {
            timeout: requestTimeout,
            headers: {
                'Content-Type': 'application/json',
                'x-clientid': clientId
            }
        });

        const org = res.data?.data?.exhibitingOrganisation;
        if (!org) return null;

        // Validate email against junk list
        let email = org.contactEmail || null;
        if (email) {
            email = email.trim().toLowerCase();
            const isJunk = JUNK_EMAIL_DOMAINS.some(d => email.endsWith('@' + d) || email.includes('.' + d));
            if (isJunk) email = null;
        }

        return {
            email,
            website: org.website || null,
            phone: org.phone || null,
            company_name: org.companyName || null
        };
    } catch (e) {
        return null;
    }
}

/**
 * Process a batch of cards concurrently via GraphQL.
 */
async function processBatch(batch, eventEditionId, clientId, requestTimeout) {
    return Promise.all(batch.map(async (card) => {
        if (!card.org_guid) return { card, result: null };
        const result = await queryGraphQL(card.org_guid, eventEditionId, clientId, requestTimeout);
        return { card, result };
    }));
}

// ─── Main Entry Point ────────────────────────────────────────────────

async function runReedExpoMiner(page, url, config = {}) {
    const maxDetails = config.max_details || DEFAULT_MAX_DETAILS;
    const concurrency = config.concurrency || DEFAULT_CONCURRENCY;
    const totalTimeout = config.total_timeout || DEFAULT_TOTAL_TIMEOUT;
    const requestTimeout = config.request_timeout || DEFAULT_REQUEST_TIMEOUT;
    const startTime = Date.now();

    console.log(`[reedExpoMiner] Starting for: ${url} (timeout: ${totalTimeout}ms, concurrency: ${concurrency})`);

    // Total timeout wrapper
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`reedExpoMiner total timeout (${totalTimeout}ms)`)), totalTimeout)
    );

    // Phase 1: Scroll and collect all exhibitor links + GUIDs + auto-detect config
    const phase1Result = await Promise.race([
        collectExhibitorLinks(page, url, config),
        timeoutPromise
    ]);

    const exhibitorCards = phase1Result.cards;
    const eventEditionId = config.event_edition_id || phase1Result.eventEditionId;
    const clientId = phase1Result.clientId || DEFAULT_CLIENT_ID;

    if (exhibitorCards.length === 0) {
        console.log('[reedExpoMiner] No exhibitor links found — returning empty.');
        return [];
    }

    if (!eventEditionId) {
        console.log('[reedExpoMiner] ERROR: eventEditionId not found — cannot query GraphQL. Returning cards without emails.');
        return exhibitorCards.map(c => ({
            company_name: c.company_name || null,
            email: null,
            phone: null,
            website: null,
            country: c.country || null,
            address: null,
            contact_name: null,
            job_title: null
        }));
    }

    // ─── Phase 2: GraphQL API (axios, no Playwright) ────────────────

    const cardsWithGuid = exhibitorCards.filter(c => c.org_guid);
    const detailLimit = Math.min(cardsWithGuid.length, maxDetails);
    const cardsToProcess = cardsWithGuid.slice(0, detailLimit);
    const estimatedBatches = Math.ceil(detailLimit / concurrency);
    const estimatedSeconds = Math.round(estimatedBatches * 0.5);
    console.log(`[reedExpoMiner] Phase 2: ${detailLimit} orgs, ~${estimatedSeconds}s estimated (concurrency: ${concurrency}, eve: ${eventEditionId}, clientId: ${clientId})`);

    let enriched = 0;
    let errors = 0;

    for (let i = 0; i < cardsToProcess.length; i += concurrency) {
        if (Date.now() - startTime > totalTimeout) {
            console.log(`[reedExpoMiner] Total timeout at ${i}/${detailLimit} — stopping.`);
            break;
        }

        const batch = cardsToProcess.slice(i, i + concurrency);
        const results = await processBatch(batch, eventEditionId, clientId, requestTimeout);

        for (const { card, result } of results) {
            if (!result) {
                errors++;
                continue;
            }

            if (result.email) {
                card.email = result.email;
                enriched++;
            }
            if (result.website) card.website = result.website;
            if (result.phone) card.phone = result.phone;
            if (result.company_name && !card.company_name) {
                card.company_name = result.company_name;
            }
        }

        // Progress log every 100 orgs
        const processed = Math.min(i + concurrency, detailLimit);
        if (processed % 100 < concurrency || processed === detailLimit) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            const rate = processed > 0 ? Math.round((enriched / processed) * 100) : 0;
            console.log(`[reedExpoMiner] Phase 2: ${processed}/${detailLimit}, +${enriched} emails (${rate}%), ${errors} errors (${elapsed}s)`);
        }
    }

    console.log(`[reedExpoMiner] Phase 2 complete: ${enriched} emails from ${detailLimit} orgs, ${errors} errors`);

    // Build final cards (include ALL exhibitors, even those without GUID)
    const cards = exhibitorCards.map(c => ({
        company_name: c.company_name || null,
        email: c.email || null,
        phone: c.phone || null,
        website: c.website || null,
        country: c.country || null,
        address: c.address || null,
        contact_name: c.contact_name || null,
        job_title: c.job_title || null
    }));

    const withEmail = cards.filter(c => c.email).length;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[reedExpoMiner] Done: ${cards.length} cards, ${withEmail} with email (${elapsed}s)`);

    return cards;
}

// ─── Exports ─────────────────────────────────────────────────────────

module.exports = { runReedExpoMiner, canHandle };
