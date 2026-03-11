/**
 * LIFFY ReedExpo Mailto Miner v1.0
 * ==================================
 *
 * Miner for ReedExpo platform sites where emails are visible as mailto:
 * links directly in the exhibitor directory HTML (no GraphQL/org-GUID needed).
 * Example: batimat.com
 *
 * Single-phase pipeline:
 *   1. Playwright infinite scroll — scroll the directory page,
 *      collecting mailto: emails + nearby company names + website links
 *      as new content loads.
 *
 * Miner contract:
 *   - Returns raw card data only (no normalization, no DB writes)
 *   - Browser lifecycle managed by flowOrchestrator wrapper
 *   - Handles its own pagination internally (ownPagination: true, ownBrowser: true)
 */

// ─── Constants ───────────────────────────────────────────────────────

const JUNK_EMAIL_DOMAINS = [
    'example.com', 'example.org', 'test.com', 'sentry.io',
    'wix.com', 'wordpress.com', 'squarespace.com',
    'googleapis.com', 'googleusercontent.com', 'gstatic.com',
    'w3.org', 'schema.org', 'facebook.com', 'twitter.com',
    'instagram.com', 'youtube.com', 'linkedin.com',
    'reedexpo.com', 'rxglobal.com'
];

const SOCIAL_HOSTS = [
    'facebook.com', 'twitter.com', 'linkedin.com', 'instagram.com',
    'youtube.com', 'pinterest.com', 'tiktok.com', 'x.com'
];

const DEFAULT_MAX_SCROLLS = 50;
const DEFAULT_SCROLL_DELAY_MS = 2000;
const DEFAULT_TOTAL_TIMEOUT = 480000; // 8 minutes

// ─── canHandle — Static Check ───────────────────────────────────────

/**
 * Check if a URL/page should use this mailto-based miner.
 * True when: ReedExpo platform + mailto: links present + no exhib_profile GUID pattern.
 * @param {string} url
 * @param {string} [pageSource] - HTML source
 * @returns {boolean}
 */
function canHandle(url, pageSource) {
    if (!pageSource || typeof pageSource !== 'string') return false;

    const hasReedExpo = pageSource.includes('api.reedexpo.com');
    const hasMailto = pageSource.includes('mailto:');
    const hasExhibProfile = pageSource.includes('exhib_profile');

    // ReedExpo platform + mailto visible + NOT org-GUID based
    return hasReedExpo && hasMailto && !hasExhibProfile;
}

// ─── Main Mining Function ───────────────────────────────────────────

async function runReedExpoMailtoMiner(page, url, config = {}) {
    const maxScrolls = config.max_scrolls || DEFAULT_MAX_SCROLLS;
    const scrollDelay = config.scroll_delay_ms || DEFAULT_SCROLL_DELAY_MS;
    const totalTimeout = config.total_timeout || DEFAULT_TOTAL_TIMEOUT;
    const startTime = Date.now();

    console.log(`[reedExpoMailtoMiner] Starting for: ${url} (maxScrolls: ${maxScrolls}, timeout: ${totalTimeout}ms)`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log(`[reedExpoMailtoMiner] Page loaded (${Date.now() - startTime}ms)`);

    // Wait for initial content
    try {
        await page.waitForSelector('a[href^="mailto:"]', { timeout: 10000 });
        console.log(`[reedExpoMailtoMiner] mailto: links detected in DOM`);
    } catch (e) {
        console.log(`[reedExpoMailtoMiner] No mailto: after 10s, waiting 5s for JS render...`);
        await page.waitForTimeout(5000);
    }

    await page.waitForTimeout(3000);

    // ─── Infinite Scroll + Collect ──────────────────────────────────

    let previousHeight = await page.evaluate(() => document.body.scrollHeight);
    let noChangeCount = 0;
    let scrollCount = 0;

    console.log(`[reedExpoMailtoMiner] Starting infinite scroll (max ${maxScrolls}, initial height=${previousHeight})`);

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
            const mailtoCount = await page.evaluate(() =>
                document.querySelectorAll('a[href^="mailto:"]').length
            );
            console.log(`[reedExpoMailtoMiner] Scroll ${scrollCount}/${maxScrolls}: ${mailtoCount} mailto links, height=${currentHeight}, noChange=${noChangeCount}`);
        }

        if (Date.now() - startTime > totalTimeout) {
            console.log(`[reedExpoMailtoMiner] Total timeout — stopping scroll`);
            break;
        }
    }

    console.log(`[reedExpoMailtoMiner] Scrolling done after ${scrollCount} scrolls (noChange=${noChangeCount}, ${Date.now() - startTime}ms)`);

    // ─── Extract Data ───────────────────────────────────────────────

    const rawCards = await page.evaluate(({ junkDomains, socialHosts }) => {
        const cards = [];
        const seenEmails = new Set();
        const mailtoLinks = document.querySelectorAll('a[href^="mailto:"]');

        for (const a of mailtoLinks) {
            const href = a.getAttribute('href') || '';
            if (href.startsWith('mailto:?')) continue;

            const email = href.replace('mailto:', '').split('?')[0].trim().toLowerCase();
            if (!email || !email.includes('@') || email.length < 6) continue;

            // Junk filter
            const isJunk = junkDomains.some(d => email.endsWith('@' + d) || email.includes('.' + d));
            if (isJunk) continue;

            // Dedup
            if (seenEmails.has(email)) continue;
            seenEmails.add(email);

            // Find company name — walk up to nearest card/container
            let companyName = null;
            const card = a.closest(
                '[class*="card"], [class*="exhibitor"], [class*="company"], ' +
                '[class*="item"], [class*="result"], li, article, tr, ' +
                '[class*="participant"], [class*="member"], [class*="vendor"]'
            );

            if (card) {
                // Try headings first
                const heading = card.querySelector('h1, h2, h3, h4');
                if (heading) {
                    companyName = heading.textContent.trim();
                }

                // Fallback: first strong or prominent text
                if (!companyName) {
                    const strong = card.querySelector('strong, b, [class*="name"], [class*="title"]');
                    if (strong) companyName = strong.textContent.trim();
                }

                // Fallback: first span/div before the mailto link
                if (!companyName) {
                    const prev = a.previousElementSibling;
                    if (prev) companyName = prev.textContent.trim().split('\n')[0].trim();
                }
            }

            // If still no name, try parent elements
            if (!companyName) {
                let el = a.parentElement;
                for (let i = 0; i < 5 && el; i++) {
                    const h = el.querySelector('h1, h2, h3, h4, strong, b');
                    if (h) {
                        companyName = h.textContent.trim();
                        break;
                    }
                    el = el.parentElement;
                }
            }

            // Find website — external link in same card
            let website = null;
            if (card) {
                const links = card.querySelectorAll('a[href^="http"]');
                for (const link of links) {
                    const linkHref = (link.getAttribute('href') || '').trim();
                    if (!linkHref) continue;
                    const linkLower = linkHref.toLowerCase();

                    // Skip social + junk
                    let skip = false;
                    for (const d of [...junkDomains, ...socialHosts]) {
                        if (linkLower.includes(d)) { skip = true; break; }
                    }
                    if (skip) continue;

                    // Skip same-site links
                    try {
                        const linkHost = new URL(linkHref).hostname;
                        if (linkHost === window.location.hostname) continue;
                    } catch (e) { continue; }

                    website = linkHref;
                    break;
                }
            }

            // Find country/location
            let country = null;
            if (card) {
                const countryEl = card.querySelector('[class*="country"], [class*="location"], [class*="stand"], small, .meta');
                if (countryEl) country = countryEl.textContent.trim();
            }

            // Clean company name
            if (companyName) {
                companyName = companyName.replace(/\s+/g, ' ').trim();
                if (companyName.length > 200) companyName = companyName.slice(0, 200);
                if (companyName.length < 2) companyName = null;
            }

            cards.push({
                email,
                company_name: companyName || null,
                website: website || null,
                country: country || null
            });
        }

        return cards;
    }, { junkDomains: JUNK_EMAIL_DOMAINS, socialHosts: SOCIAL_HOSTS });

    // Build final cards
    const cards = rawCards.map(c => ({
        company_name: c.company_name || null,
        email: c.email || null,
        phone: null,
        website: c.website || null,
        country: c.country || null,
        address: null,
        contact_name: null,
        job_title: null
    }));

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[reedExpoMailtoMiner] Done: ${cards.length} cards with email (${elapsed}s)`);

    return cards;
}

// ─── Exports ─────────────────────────────────────────────────────────

module.exports = { runReedExpoMailtoMiner, canHandle };
