/**
 * LIFFY MCE Expocomfort Miner v3.0
 * ==================================
 *
 * Specialized miner for mcexpocomfort.it exhibitor directory.
 *
 * Two-phase pipeline:
 *   1. Infinite scroll — scroll the list page, collect exhibitor detail URLs
 *   2. Network interception — visit detail pages, capture API calls + mailto emails
 *
 * Phase 2 strategy:
 *   - DEBUG MODE: Visit first 3 detail pages with network interception
 *   - Log all API calls made by the page (reedexpo, organisations, exhibitors)
 *   - Also extract mailto: emails from HTML as fallback
 *   - Once correct API endpoint is identified, switch to bulk API mode
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
const DEFAULT_TOTAL_TIMEOUT = 300000; // 5 minutes
const DEFAULT_DETAIL_DELAY_MS = 1500;

// ─── Phase 1: Infinite Scroll — Collect Links ───────────────────────

/**
 * Scroll the page to the bottom repeatedly until no new content loads.
 * Returns array of { detail_url, company_name, country }.
 */
async function collectExhibitorLinks(page, url, config) {
    const maxScrolls = config.max_scrolls || DEFAULT_MAX_SCROLLS;
    const scrollDelay = config.scroll_delay_ms || DEFAULT_SCROLL_DELAY_MS;
    const startTime = Date.now();

    console.log(`[mcexpocomfortMiner] Phase 1: Navigating to ${url}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log(`[mcexpocomfortMiner] Phase 1: Page loaded (${Date.now() - startTime}ms)`);

    // Wait for initial content to render
    try {
        await page.waitForSelector('a[href*="exhib_profile"]', { timeout: 10000 });
        console.log(`[mcexpocomfortMiner] Phase 1: Exhibitor links detected in DOM`);
    } catch (e) {
        console.log(`[mcexpocomfortMiner] Phase 1: No exhibitor links after 10s, waiting 3s for JS render...`);
        await page.waitForTimeout(3000);
    }

    // Extra settle time for JS-heavy pages
    await page.waitForTimeout(3000);
    console.log(`[mcexpocomfortMiner] Phase 1: Ready to scroll (${Date.now() - startTime}ms)`);

    let previousHeight = await page.evaluate(() => document.body.scrollHeight);
    let noChangeCount = 0;
    let scrollCount = 0;

    console.log(`[mcexpocomfortMiner] Phase 1: Starting infinite scroll (max ${maxScrolls} scrolls, initial height=${previousHeight})`);

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
            const linkCount = await page.evaluate(() => {
                return document.querySelectorAll('a[href*="exhib_profile"]').length;
            });
            console.log(`[mcexpocomfortMiner] Scroll ${scrollCount}/${maxScrolls}: ${linkCount} links, height=${currentHeight}, noChange=${noChangeCount}`);
        }

        // Phase 1 timeout guard (use half of total timeout)
        if (Date.now() - startTime > 150000) {
            console.log(`[mcexpocomfortMiner] Phase 1 timeout (150s) — stopping scroll`);
            break;
        }
    }

    console.log(`[mcexpocomfortMiner] Scrolling done after ${scrollCount} scrolls (noChange=${noChangeCount}, ${Date.now() - startTime}ms)`);

    // Collect all exhibitor detail links + company names from page
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

            // Try to get company name from the card
            const card = a.closest('[class*="card"], [class*="exhibitor"], [class*="item"], li, article') || a;
            const nameEl = card.querySelector('h2, h3, h4, .title, [class*="name"], [class*="title"]');
            const companyName = nameEl
                ? nameEl.textContent.trim()
                : a.textContent.trim().split('\n')[0].trim();

            // Try to get country/stand info
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

// ─── Phase 2: Network Interception + Detail Page Visit ──────────────

/**
 * Visit a detail page with network interception enabled.
 * Captures all API calls and extracts email from HTML.
 * Returns { apiCalls, email, allEmails }.
 */
async function visitDetailWithIntercept(page, detailUrl, junkDomains, debugMode) {
    const apiCalls = [];

    // Set up network interception
    const onRequest = (req) => {
        const url = req.url();
        if (url.includes('api.reedexpo.com') ||
            url.includes('reedexpo') ||
            url.includes('organisations') ||
            url.includes('exhibitors')) {
            apiCalls.push({
                url: url,
                method: req.method(),
                headers: req.headers()
            });
        }
    };

    page.on('request', onRequest);

    try {
        await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 30000 });
    } catch (e) {
        // networkidle timeout is OK — page may keep loading ads etc.
        if (debugMode) {
            console.log(`[MCE DEBUG] goto timeout for ${detailUrl}: ${e.message}`);
        }
    }

    // Remove listener to avoid leaks
    page.removeListener('request', onRequest);

    // Extract mailto: email from HTML
    let email = null;
    try {
        email = await page.$eval(
            'a[href^="mailto:"]',
            (el) => el.href.replace('mailto:', '').split('?')[0].trim().toLowerCase()
        );
    } catch (e) {
        // No mailto: link found
    }

    // Also regex scan for emails in body text
    const allEmails = await page.evaluate(({ junkDomains: jd }) => {
        const found = [];

        // mailto: links first
        for (const a of document.querySelectorAll('a[href^="mailto:"]')) {
            const href = a.getAttribute('href') || '';
            if (href.startsWith('mailto:?')) continue;
            const em = href.replace('mailto:', '').split('?')[0].trim().toLowerCase();
            if (em && em.includes('@') && em.length > 5) {
                const isJunk = jd.some(d => em.endsWith('@' + d) || em.includes('.' + d));
                if (!isJunk && !found.includes(em)) found.push(em);
            }
        }

        // Regex on body text
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
    }, { junkDomains: junkDomains });

    // Use first non-junk email
    if (!email && allEmails.length > 0) {
        email = allEmails[0];
    }

    // Validate email against junk list
    if (email) {
        const isJunk = junkDomains.some(d => email.endsWith('@' + d) || email.includes('.' + d));
        if (isJunk) email = null;
    }

    return { apiCalls, email, allEmails };
}

// ─── Main Entry Point ────────────────────────────────────────────────

async function runMcexpocomfortMiner(page, url, config = {}) {
    const maxDetails = config.max_details || DEFAULT_MAX_DETAILS;
    const detailDelay = config.delay_ms || DEFAULT_DETAIL_DELAY_MS;
    const totalTimeout = config.total_timeout || DEFAULT_TOTAL_TIMEOUT;
    const startTime = Date.now();

    console.log(`[mcexpocomfortMiner] Starting for: ${url} (timeout: ${totalTimeout}ms)`);

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

    // ─── Phase 2: Network Interception Debug + Email Extraction ──────

    const detailLimit = Math.min(exhibitorCards.length, maxDetails);
    console.log(`[mcexpocomfortMiner] Phase 2: Visiting ${detailLimit} detail pages (first 3 with network debug)...`);

    let enriched = 0;
    let consecutiveErrors = 0;

    for (let i = 0; i < detailLimit; i++) {
        // Timeout check
        if (Date.now() - startTime > totalTimeout) {
            console.log(`[mcexpocomfortMiner] Total timeout at ${i}/${detailLimit} — stopping.`);
            break;
        }

        // Circuit breaker
        if (consecutiveErrors >= 5) {
            console.log(`[mcexpocomfortMiner] 5 consecutive errors — stopping detail crawl.`);
            break;
        }

        const card = exhibitorCards[i];
        const isDebug = i < 3; // First 3 with full debug

        try {
            const result = await visitDetailWithIntercept(page, card.detail_url, JUNK_EMAIL_DOMAINS, isDebug);

            // DEBUG: Log API calls for first 3 orgs
            if (isDebug) {
                console.log(`[MCE DEBUG] API calls for ${card.company_name || card.detail_url}:`);
                if (result.apiCalls.length === 0) {
                    console.log('  (none)');
                } else {
                    result.apiCalls.forEach(c => {
                        console.log(`  ${c.method} ${c.url}`);
                        // Log auth-related headers
                        const authHeader = c.headers['authorization'] || c.headers['Authorization'] || null;
                        const clientId = c.headers['x-clientid'] || c.headers['X-ClientId'] || null;
                        if (authHeader) console.log(`    Authorization: ${authHeader.slice(0, 50)}...`);
                        if (clientId) console.log(`    x-clientid: ${clientId}`);
                    });
                }
                console.log(`[MCE DEBUG] mailto email: ${result.email || 'NOT FOUND'}`);
                if (result.allEmails.length > 0) {
                    console.log(`[MCE DEBUG] all emails: ${result.allEmails.join(', ')}`);
                }
            }

            consecutiveErrors = 0;

            // Enrich card with email
            if (result.allEmails.length > 0) {
                card.email = result.allEmails[0];
                card.all_emails = result.allEmails;
                enriched++;
            } else if (result.email) {
                card.email = result.email;
                enriched++;
            }

            // Polite delay
            await page.waitForTimeout(detailDelay);

        } catch (e) {
            consecutiveErrors++;
            if (isDebug) {
                console.log(`[MCE DEBUG] Error visiting ${card.detail_url}: ${e.message}`);
            }
        }

        // Progress log every 25 detail pages
        if ((i + 1) % 25 === 0) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            console.log(`[mcexpocomfortMiner] Detail progress: ${i + 1}/${detailLimit}, +${enriched} emails (${elapsed}s)`);
        }
    }

    console.log(`[mcexpocomfortMiner] Phase 2 complete: ${enriched} emails from ${detailLimit} detail pages`);

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
