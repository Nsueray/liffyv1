/**
 * LIFFY MCE Expocomfort Miner v6.0
 * ==================================
 *
 * Specialized miner for mcexpocomfort.it exhibitor directory.
 *
 * Two-phase pipeline:
 *   1. Infinite scroll (Playwright) — scroll list page, collect detail URLs + org GUIDs
 *   2. GraphQL API (axios) — batch query ReedExpo GraphQL for contactEmail/website/phone
 *      Concurrency 20, 10s timeout per request. ~41s for 1635 orgs.
 *
 * Miner contract:
 *   - Returns raw card data only (no normalization, no DB writes)
 *   - Browser lifecycle managed by flowOrchestrator wrapper
 *   - Handles its own pagination internally (ownPagination: true, ownBrowser: true)
 */

const axios = require('axios');

// ─── Constants ───────────────────────────────────────────────────────

const GRAPHQL_URL = 'https://api.reedexpo.com/graphql/';
const GRAPHQL_CLIENT_ID = 'uhQVcmxLwXAjVtVpTvoerERiZSsNz0om';
const MCE_EVENT_EDITION_ID = 'eve-57a81c89-bb6c-4549-9448-a711fe3e7d22';

// Pattern: exhib_profile.COMPANY_NAME.org-GUID.html → extract "org-GUID"
const ORG_GUID_REGEX = /exhib_profile\.[^.]+\.(org-[a-f0-9\-]+)\.html/i;

const JUNK_EMAIL_DOMAINS = [
    'example.com', 'example.org', 'test.com', 'sentry.io',
    'wix.com', 'wordpress.com', 'squarespace.com',
    'googleapis.com', 'googleusercontent.com', 'gstatic.com',
    'w3.org', 'schema.org', 'facebook.com', 'twitter.com',
    'instagram.com', 'youtube.com', 'linkedin.com',
    'mcexpocomfort.it', 'reedexpo.com', 'rxglobal.com'
];

const DEFAULT_MAX_SCROLLS = 50;
const DEFAULT_SCROLL_DELAY_MS = 2000;
const DEFAULT_MAX_DETAILS = 2000;
const DEFAULT_TOTAL_TIMEOUT = 300000; // 5 minutes
const DEFAULT_CONCURRENCY = 20;
const DEFAULT_REQUEST_TIMEOUT = 10000; // 10s per request

// ─── Phase 1: Infinite Scroll — Collect Links + Extract GUIDs ───────

async function collectExhibitorLinks(page, url, config) {
    const maxScrolls = config.max_scrolls || DEFAULT_MAX_SCROLLS;
    const scrollDelay = config.scroll_delay_ms || DEFAULT_SCROLL_DELAY_MS;
    const startTime = Date.now();

    console.log(`[mcexpocomfortMiner] Phase 1: Navigating to ${url}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log(`[mcexpocomfortMiner] Phase 1: Page loaded (${Date.now() - startTime}ms)`);

    try {
        await page.waitForSelector('a[href*="exhib_profile"]', { timeout: 10000 });
        console.log(`[mcexpocomfortMiner] Phase 1: Exhibitor links detected in DOM`);
    } catch (e) {
        console.log(`[mcexpocomfortMiner] Phase 1: No exhibitor links after 10s, waiting 3s for JS render...`);
        await page.waitForTimeout(3000);
    }

    await page.waitForTimeout(3000);
    console.log(`[mcexpocomfortMiner] Phase 1: Ready to scroll (${Date.now() - startTime}ms)`);

    let previousHeight = await page.evaluate(() => document.body.scrollHeight);
    let noChangeCount = 0;
    let scrollCount = 0;

    console.log(`[mcexpocomfortMiner] Phase 1: Starting infinite scroll (max ${maxScrolls}, initial height=${previousHeight})`);

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
            console.log(`[mcexpocomfortMiner] Scroll ${scrollCount}/${maxScrolls}: ${linkCount} links, height=${currentHeight}, noChange=${noChangeCount}`);
        }

        if (Date.now() - startTime > 150000) {
            console.log(`[mcexpocomfortMiner] Phase 1 timeout (150s) — stopping scroll`);
            break;
        }
    }

    console.log(`[mcexpocomfortMiner] Scrolling done after ${scrollCount} scrolls (noChange=${noChangeCount}, ${Date.now() - startTime}ms)`);

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
    console.log(`[mcexpocomfortMiner] Phase 1 complete: ${cardData.length} exhibitors, ${withGuid} with GUID`);
    return cardData;
}

// ─── Phase 2: GraphQL API — Email Extraction ────────────────────────

/**
 * Query ReedExpo GraphQL for a single organisation.
 */
async function queryGraphQL(orgGuid, eventEditionId, requestTimeout) {
    try {
        const res = await axios.post(GRAPHQL_URL, {
            query: `{ exhibitingOrganisation(eventEditionId:"${eventEditionId}", organisationId:"${orgGuid}") { companyName contactEmail website phone } }`
        }, {
            timeout: requestTimeout,
            headers: {
                'Content-Type': 'application/json',
                'x-clientid': GRAPHQL_CLIENT_ID
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
        // Timeout, network error, GraphQL error — skip
        return null;
    }
}

/**
 * Process a batch of cards concurrently via GraphQL.
 */
async function processBatch(batch, eventEditionId, requestTimeout) {
    return Promise.all(batch.map(async (card) => {
        if (!card.org_guid) return { card, result: null };
        const result = await queryGraphQL(card.org_guid, eventEditionId, requestTimeout);
        return { card, result };
    }));
}

// ─── Main Entry Point ────────────────────────────────────────────────

async function runMcexpocomfortMiner(page, url, config = {}) {
    const maxDetails = config.max_details || DEFAULT_MAX_DETAILS;
    const concurrency = config.concurrency || DEFAULT_CONCURRENCY;
    const totalTimeout = config.total_timeout || DEFAULT_TOTAL_TIMEOUT;
    const requestTimeout = config.request_timeout || DEFAULT_REQUEST_TIMEOUT;
    const eventEditionId = config.event_edition_id || MCE_EVENT_EDITION_ID;
    const startTime = Date.now();

    console.log(`[mcexpocomfortMiner] Starting for: ${url} (timeout: ${totalTimeout}ms, concurrency: ${concurrency})`);

    // Total timeout wrapper
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`mcexpocomfortMiner total timeout (${totalTimeout}ms)`)), totalTimeout)
    );

    // Phase 1: Scroll and collect all exhibitor links + GUIDs
    const exhibitorCards = await Promise.race([
        collectExhibitorLinks(page, url, config),
        timeoutPromise
    ]);

    if (exhibitorCards.length === 0) {
        console.log('[mcexpocomfortMiner] No exhibitor links found — returning empty.');
        return [];
    }

    // ─── Phase 2: GraphQL API (axios, no Playwright) ────────────────

    const cardsWithGuid = exhibitorCards.filter(c => c.org_guid);
    const detailLimit = Math.min(cardsWithGuid.length, maxDetails);
    const cardsToProcess = cardsWithGuid.slice(0, detailLimit);
    const estimatedBatches = Math.ceil(detailLimit / concurrency);
    const estimatedSeconds = Math.round(estimatedBatches * 0.5);
    console.log(`[mcexpocomfortMiner] Phase 2: ${detailLimit} orgs, ~${estimatedSeconds} seconds estimated (concurrency: ${concurrency})`);

    let enriched = 0;
    let errors = 0;

    for (let i = 0; i < cardsToProcess.length; i += concurrency) {
        // Timeout check
        if (Date.now() - startTime > totalTimeout) {
            console.log(`[mcexpocomfortMiner] Total timeout at ${i}/${detailLimit} — stopping.`);
            break;
        }

        const batch = cardsToProcess.slice(i, i + concurrency);
        const results = await processBatch(batch, eventEditionId, requestTimeout);

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
            // GraphQL may return a better company name
            if (result.company_name && !card.company_name) {
                card.company_name = result.company_name;
            }
        }

        // Progress log every 100 orgs
        const processed = Math.min(i + concurrency, detailLimit);
        if (processed % 100 < concurrency || processed === detailLimit) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            const rate = processed > 0 ? Math.round((enriched / processed) * 100) : 0;
            console.log(`[mcexpocomfortMiner] Phase 2: ${processed}/${detailLimit}, +${enriched} emails (${rate}%), ${errors} errors (${elapsed}s)`);
        }
    }

    console.log(`[mcexpocomfortMiner] Phase 2 complete: ${enriched} emails from ${detailLimit} orgs, ${errors} errors`);

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
    console.log(`[mcexpocomfortMiner] Done: ${cards.length} cards, ${withEmail} with email (${elapsed}s)`);

    return cards;
}

// ─── Exports ─────────────────────────────────────────────────────────

module.exports = { runMcexpocomfortMiner };
