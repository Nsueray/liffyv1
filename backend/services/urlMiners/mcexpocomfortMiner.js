/**
 * LIFFY MCE Expocomfort Miner v4.0
 * ==================================
 *
 * Specialized miner for mcexpocomfort.it exhibitor directory.
 *
 * Two-phase pipeline:
 *   1. Infinite scroll (Playwright) — scroll list page, collect detail URLs
 *   2. HTTP fetch (axios) — fetch each detail page HTML, extract emails via regex
 *      No Playwright in Phase 2. Concurrency 20, ~10s timeout per request.
 *
 * Miner contract:
 *   - Returns raw card data only (no normalization, no DB writes)
 *   - Browser lifecycle managed by flowOrchestrator wrapper
 *   - Handles its own pagination internally (ownPagination: true, ownBrowser: true)
 */

const axios = require('axios');

// ─── Constants ───────────────────────────────────────────────────────

const EMAIL_REGEX = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;

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
const DEFAULT_TOTAL_TIMEOUT = 600000; // 10 minutes (increased for HTTP phase)
const DEFAULT_CONCURRENCY = 20;
const DEFAULT_REQUEST_TIMEOUT = 10000; // 10s per request

// ─── Phase 1: Infinite Scroll — Collect Links ───────────────────────

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

    console.log(`[mcexpocomfortMiner] Phase 1 complete: ${cardData.length} unique exhibitor links`);
    return cardData;
}

// ─── Phase 2: HTTP Fetch + Email Regex ──────────────────────────────

/**
 * Extract emails from raw HTML string.
 */
function extractEmailsFromHTML(html) {
    const emails = [];
    if (!html) return emails;

    // 1. mailto: links
    const mailtoRegex = /mailto:([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})/gi;
    let m;
    while ((m = mailtoRegex.exec(html)) !== null) {
        const email = m[1].toLowerCase();
        if (!emails.includes(email)) {
            const isJunk = JUNK_EMAIL_DOMAINS.some(d => email.endsWith('@' + d) || email.includes('.' + d));
            if (!isJunk) emails.push(email);
        }
    }

    // 2. General email regex on full HTML
    const allMatches = html.match(EMAIL_REGEX) || [];
    for (const raw of allMatches) {
        const email = raw.toLowerCase();
        if (emails.includes(email)) continue;
        const isJunk = JUNK_EMAIL_DOMAINS.some(d => email.endsWith('@' + d) || email.includes('.' + d));
        if (!isJunk) emails.push(email);
    }

    return emails;
}

/**
 * Fetch a single detail page via HTTP and extract emails.
 */
async function fetchDetailPage(detailUrl, requestTimeout) {
    try {
        const res = await axios.get(detailUrl, {
            timeout: requestTimeout,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            maxRedirects: 3,
            validateStatus: (status) => status < 400,
        });

        const html = typeof res.data === 'string' ? res.data : '';
        return extractEmailsFromHTML(html);
    } catch (e) {
        // Timeout, network error, 4xx — skip silently
        return null;
    }
}

/**
 * Process a chunk of cards concurrently.
 */
async function processChunk(chunk, requestTimeout) {
    return Promise.all(chunk.map(async (card) => {
        const emails = await fetchDetailPage(card.detail_url, requestTimeout);
        return { card, emails };
    }));
}

// ─── Main Entry Point ────────────────────────────────────────────────

async function runMcexpocomfortMiner(page, url, config = {}) {
    const maxDetails = config.max_details || DEFAULT_MAX_DETAILS;
    const concurrency = config.concurrency || DEFAULT_CONCURRENCY;
    const totalTimeout = config.total_timeout || DEFAULT_TOTAL_TIMEOUT;
    const requestTimeout = config.request_timeout || DEFAULT_REQUEST_TIMEOUT;
    const startTime = Date.now();

    console.log(`[mcexpocomfortMiner] Starting for: ${url} (timeout: ${totalTimeout}ms, concurrency: ${concurrency})`);

    // Total timeout wrapper
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`mcexpocomfortMiner total timeout (${totalTimeout}ms)`)), totalTimeout)
    );

    // Phase 1: Scroll and collect all exhibitor links
    const exhibitorCards = await Promise.race([
        collectExhibitorLinks(page, url, config),
        timeoutPromise
    ]);

    if (exhibitorCards.length === 0) {
        console.log('[mcexpocomfortMiner] No exhibitor links found — returning empty.');
        return [];
    }

    // ─── Phase 2: HTTP Fetch (axios, no Playwright) ─────────────────

    const detailLimit = Math.min(exhibitorCards.length, maxDetails);
    const cardsToProcess = exhibitorCards.slice(0, detailLimit);
    const estimatedSeconds = Math.ceil(detailLimit / concurrency) * 0.5; // ~0.5s avg per batch
    console.log(`[mcexpocomfortMiner] Phase 2: ${detailLimit} pages, ~${estimatedSeconds} seconds estimated (concurrency: ${concurrency})`);

    let enriched = 0;
    let errors = 0;

    for (let i = 0; i < cardsToProcess.length; i += concurrency) {
        // Timeout check
        if (Date.now() - startTime > totalTimeout) {
            console.log(`[mcexpocomfortMiner] Total timeout at ${i}/${detailLimit} — stopping.`);
            break;
        }

        const chunk = cardsToProcess.slice(i, i + concurrency);
        const results = await processChunk(chunk, requestTimeout);

        for (const { card, emails } of results) {
            if (emails === null) {
                errors++;
                continue;
            }

            if (emails.length > 0) {
                card.email = emails[0];
                card.all_emails = emails;
                enriched++;
            }
        }

        // Progress log every 100 pages
        const processed = Math.min(i + concurrency, detailLimit);
        if (processed % 100 === 0 || processed === detailLimit) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            console.log(`[mcexpocomfortMiner] Phase 2 progress: ${processed}/${detailLimit}, +${enriched} emails, ${errors} errors (${elapsed}s)`);
        }
    }

    console.log(`[mcexpocomfortMiner] Phase 2 complete: ${enriched} emails from ${detailLimit} pages, ${errors} errors`);

    // Build final cards
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
