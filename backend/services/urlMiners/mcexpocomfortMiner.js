/**
 * LIFFY MCE Expocomfort Miner v5.0
 * ==================================
 *
 * Specialized miner for mcexpocomfort.it exhibitor directory.
 *
 * Two-phase pipeline:
 *   1. Infinite scroll (Playwright) — scroll list page, collect detail URLs
 *   2. Playwright detail pages — 3 concurrent browser tabs, mailto: + regex email extraction
 *      20s timeout per page, 8 min total timeout.
 *
 * Miner contract:
 *   - Returns raw card data only (no normalization, no DB writes)
 *   - Browser lifecycle managed by flowOrchestrator wrapper
 *   - Handles its own pagination internally (ownPagination: true, ownBrowser: true)
 */

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
const DEFAULT_TOTAL_TIMEOUT = 480000; // 8 minutes
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_PAGE_TIMEOUT = 20000; // 20s per detail page

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

// ─── Phase 2: Playwright Concurrent Detail Pages ────────────────────

/**
 * Extract emails from a Playwright page (mailto: links + body text regex).
 */
async function extractEmailsFromPage(detailPage, junkDomains) {
    return detailPage.evaluate(({ jd }) => {
        const found = [];

        // 1. mailto: links
        for (const a of document.querySelectorAll('a[href^="mailto:"]')) {
            const href = a.getAttribute('href') || '';
            if (href.startsWith('mailto:?')) continue;
            const em = href.replace('mailto:', '').split('?')[0].trim().toLowerCase();
            if (em && em.includes('@') && em.length > 5) {
                const isJunk = jd.some(d => em.endsWith('@' + d) || em.includes('.' + d));
                if (!isJunk && !found.includes(em)) found.push(em);
            }
        }

        // 2. Regex on visible text
        const bodyText = document.body ? document.body.innerText : '';
        const regex = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
        let m;
        while ((m = regex.exec(bodyText)) !== null) {
            const em = m[0].toLowerCase();
            if (!found.includes(em)) {
                const isJunk = jd.some(d => em.endsWith('@' + d) || em.includes('.' + d));
                if (!isJunk) found.push(em);
            }
        }

        return found;
    }, { jd: junkDomains });
}

/**
 * Visit a single detail page in a dedicated tab, extract emails.
 * Returns array of emails or null on error.
 */
async function visitDetailPage(context, detailUrl, pageTimeout, junkDomains) {
    let detailPage;
    try {
        detailPage = await context.newPage();

        await detailPage.goto(detailUrl, {
            waitUntil: 'domcontentloaded',
            timeout: pageTimeout
        });

        // Brief wait for JS-rendered mailto: links
        try {
            await detailPage.waitForSelector('a[href^="mailto:"]', { timeout: 3000 });
        } catch (e) {
            // No mailto: found quickly — still try regex
        }

        const emails = await extractEmailsFromPage(detailPage, junkDomains);
        return emails;
    } catch (e) {
        // Timeout, navigation error — skip
        return null;
    } finally {
        if (detailPage) {
            await detailPage.close().catch(() => {});
        }
    }
}

/**
 * Process a chunk of cards concurrently using separate browser tabs.
 */
async function processChunk(context, chunk, pageTimeout, junkDomains) {
    return Promise.all(chunk.map(async (card) => {
        const emails = await visitDetailPage(context, card.detail_url, pageTimeout, junkDomains);
        return { card, emails };
    }));
}

// ─── Main Entry Point ────────────────────────────────────────────────

async function runMcexpocomfortMiner(page, url, config = {}) {
    const maxDetails = config.max_details || DEFAULT_MAX_DETAILS;
    const concurrency = config.concurrency || DEFAULT_CONCURRENCY;
    const totalTimeout = config.total_timeout || DEFAULT_TOTAL_TIMEOUT;
    const pageTimeout = config.page_timeout || DEFAULT_PAGE_TIMEOUT;
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

    // ─── Phase 2: Playwright detail pages (concurrent tabs) ─────────

    const context = page.context();
    const detailLimit = Math.min(exhibitorCards.length, maxDetails);
    const cardsToProcess = exhibitorCards.slice(0, detailLimit);
    const estimatedSeconds = Math.ceil(detailLimit / concurrency) * 3; // ~3s avg per batch of 3
    console.log(`[mcexpocomfortMiner] Phase 2: ${detailLimit} pages, ~${estimatedSeconds}s estimated (concurrency: ${concurrency})`);

    let enriched = 0;
    let errors = 0;

    for (let i = 0; i < cardsToProcess.length; i += concurrency) {
        // Timeout check
        if (Date.now() - startTime > totalTimeout) {
            console.log(`[mcexpocomfortMiner] Total timeout at ${i}/${detailLimit} — stopping.`);
            break;
        }

        const chunk = cardsToProcess.slice(i, i + concurrency);
        const results = await processChunk(context, chunk, pageTimeout, JUNK_EMAIL_DOMAINS);

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

        // Progress log every 50 pages
        const processed = Math.min(i + concurrency, detailLimit);
        if (processed % 50 < concurrency || processed === detailLimit) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            const rate = enriched > 0 ? Math.round((enriched / processed) * 100) : 0;
            console.log(`[mcexpocomfortMiner] Phase 2: ${processed}/${detailLimit}, +${enriched} emails (${rate}%), ${errors} errors (${elapsed}s)`);
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
