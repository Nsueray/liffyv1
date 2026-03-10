/**
 * LIFFY MCE Expocomfort Miner v1.0
 * ==================================
 *
 * Specialized miner for mcexpocomfort.it exhibitor directory.
 * The site uses infinite scroll to load exhibitor cards progressively.
 * Each card links to a detail page containing email addresses.
 *
 * Two-phase pipeline:
 *   1. Infinite scroll — scroll the list page until no new content loads,
 *      collecting all exhibitor detail URLs
 *   2. Detail pages — visit each exhibitor profile, extract email via regex
 *
 * Miner contract:
 *   - Returns raw card data only (no normalization, no DB writes)
 *   - Browser lifecycle managed by flowOrchestrator wrapper
 *   - Handles its own pagination internally (ownPagination: true, ownBrowser: true)
 *
 * Usage (module only):
 *   const { runMcexpocomfortMiner } = require("./mcexpocomfortMiner");
 *   const cards = await runMcexpocomfortMiner(page, url, config);
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

const SOCIAL_HOSTS = [
    'facebook.com', 'twitter.com', 'linkedin.com', 'instagram.com',
    'youtube.com', 'pinterest.com', 'tiktok.com', 'x.com',
    'xing.com', 'wa.me', 'vimeo.com'
];

const DEFAULT_MAX_SCROLLS = 50;
const DEFAULT_SCROLL_DELAY_MS = 2000;
const DEFAULT_DETAIL_DELAY_MS = 1500;
const DEFAULT_MAX_DETAILS = 500;
const DEFAULT_TOTAL_TIMEOUT = 300000; // 5 minutes

// Detail link pattern: /exhibitor-directory/exhib_profile*
const DETAIL_LINK_PATTERN = /\/exhibitor-directory\/exhib_profile/;

// ─── Phase 1: Infinite Scroll — Collect All Detail Links ────────────

/**
 * Scroll the page to the bottom repeatedly until no new content loads.
 * Returns array of unique exhibitor detail URLs.
 */
async function collectExhibitorLinks(page, url, config) {
    const maxScrolls = config.max_scrolls || DEFAULT_MAX_SCROLLS;
    const scrollDelay = config.scroll_delay_ms || DEFAULT_SCROLL_DELAY_MS;
    const startTime = Date.now();

    console.log(`[mcexpocomfortMiner] Phase 1: Navigating to ${url}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log(`[mcexpocomfortMiner] Phase 1: Page loaded (${Date.now() - startTime}ms)`);

    // Wait for initial content to render — try exhibitor links first, then general wait
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

        // Log every scroll for first 5, then every 10
        const shouldLog = scrollCount <= 5 || scrollCount % 10 === 0;

        // Scroll to bottom
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(scrollDelay);

        // Check if new content loaded
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

    // Collect all exhibitor detail links
    const links = await page.evaluate(() => {
        const anchors = document.querySelectorAll('a[href*="exhib_profile"]');
        const urls = new Set();
        for (const a of anchors) {
            const href = a.getAttribute('href');
            if (href) {
                // Resolve relative URLs
                try {
                    const fullUrl = new URL(href, window.location.origin).href;
                    urls.add(fullUrl);
                } catch (e) {
                    // skip invalid URLs
                }
            }
        }
        return Array.from(urls);
    });

    // Also try to extract company names from the list page cards
    const cardData = await page.evaluate(() => {
        const cards = [];
        // Try common card patterns
        const anchors = document.querySelectorAll('a[href*="exhib_profile"]');
        for (const a of anchors) {
            const href = a.getAttribute('href');
            if (!href) continue;

            let fullUrl;
            try {
                fullUrl = new URL(href, window.location.origin).href;
            } catch (e) { continue; }

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

        // Dedup by detail_url
        const seen = new Set();
        return cards.filter(c => {
            if (seen.has(c.detail_url)) return false;
            seen.add(c.detail_url);
            return true;
        });
    });

    console.log(`[mcexpocomfortMiner] Phase 1 complete: ${cardData.length} unique exhibitor links`);
    return cardData;
}

// ─── Phase 2: Detail Pages — Email Extraction ────────────────────────

/**
 * Visit a single detail page and extract email + contact info.
 */
async function extractDetailPage(page, detailUrl, delayMs) {
    try {
        await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

        // Wait briefly for dynamic content
        try {
            await page.waitForSelector('a[href^="mailto:"], [class*="email"], [class*="contact"]', { timeout: 5000 });
        } catch (e) {
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        }

        const data = await page.evaluate((junkDomains, socialHosts) => {
            const result = {
                emails: [],
                phones: [],
                website: null,
                address: null,
                country: null,
                contact_name: null,
                job_title: null
            };

            // 1. mailto: links
            const mailtoLinks = document.querySelectorAll('a[href^="mailto:"]');
            for (const a of mailtoLinks) {
                const href = a.getAttribute('href') || '';
                if (href.startsWith('mailto:?')) continue;
                const email = href.replace('mailto:', '').split('?')[0].trim().toLowerCase();
                if (email && email.includes('@') && email.length > 5) {
                    const isJunk = junkDomains.some(d => email.endsWith('@' + d) || email.includes('.' + d));
                    if (!isJunk) result.emails.push(email);
                }
            }

            // 2. Email regex on page text
            const bodyText = document.body ? document.body.innerText : '';
            const emailRegex = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
            let match;
            while ((match = emailRegex.exec(bodyText)) !== null) {
                const email = match[0].toLowerCase();
                if (result.emails.includes(email)) continue;
                const isJunk = junkDomains.some(d => email.endsWith('@' + d) || email.includes('.' + d));
                if (!isJunk) result.emails.push(email);
            }

            // 3. Phone: tel: links
            const telLinks = document.querySelectorAll('a[href^="tel:"]');
            for (const a of telLinks) {
                const phone = (a.getAttribute('href') || '').replace('tel:', '').trim();
                if (phone && phone.replace(/\D/g, '').length >= 7) {
                    result.phones.push(phone);
                }
            }

            // 4. Website: external links (not social, not fair site)
            const allAnchors = document.querySelectorAll('a[href^="http"]');
            for (const a of allAnchors) {
                const href = (a.getAttribute('href') || '').trim();
                if (!href) continue;
                const hrefLower = href.toLowerCase();

                let skip = false;
                for (const d of [...junkDomains, ...socialHosts]) {
                    if (hrefLower.includes(d)) { skip = true; break; }
                }
                if (skip) continue;

                // Look for website-labeled links
                const text = (a.textContent || '').trim().toLowerCase();
                const parentText = (a.parentElement?.textContent || '').toLowerCase();
                if (text.includes('website') || text.includes('www.') || text.includes('homepage') ||
                    parentText.includes('website') || parentText.includes('homepage') ||
                    text.includes('visit site') || text.startsWith('http')) {
                    result.website = href;
                    break;
                }
            }

            // 5. If no labeled website link, take the first external http link
            if (!result.website) {
                for (const a of allAnchors) {
                    const href = (a.getAttribute('href') || '').trim();
                    if (!href) continue;
                    const hrefLower = href.toLowerCase();
                    let skip = false;
                    for (const d of [...junkDomains, ...socialHosts]) {
                        if (hrefLower.includes(d)) { skip = true; break; }
                    }
                    if (!skip && href.startsWith('http')) {
                        result.website = href;
                        break;
                    }
                }
            }

            // 6. Address
            const addressSelectors = [
                '[class*="address"]', '[class*="location"]',
                '.address', '.adr', '[itemprop="address"]'
            ];
            for (const sel of addressSelectors) {
                try {
                    const el = document.querySelector(sel);
                    if (el && el.innerText && el.innerText.trim().length > 10) {
                        result.address = el.innerText.trim().replace(/\s+/g, ' ');
                        break;
                    }
                } catch (e) { /* ignore */ }
            }

            // 7. Country — from address or dedicated element
            const countrySelectors = [
                '[class*="country"]', '[itemprop="addressCountry"]'
            ];
            for (const sel of countrySelectors) {
                try {
                    const el = document.querySelector(sel);
                    if (el && el.textContent.trim().length > 1) {
                        result.country = el.textContent.trim();
                        break;
                    }
                } catch (e) { /* ignore */ }
            }

            return result;
        }, JUNK_EMAIL_DOMAINS, SOCIAL_HOSTS);

        // Polite delay
        await page.waitForTimeout(delayMs);

        return data;
    } catch (e) {
        console.warn(`[mcexpocomfortMiner] Detail page error (${detailUrl}): ${e.message}`);
        return null;
    }
}

// ─── Main Entry Point ────────────────────────────────────────────────

async function runMcexpocomfortMiner(page, url, config = {}) {
    const detailDelay = config.delay_ms || DEFAULT_DETAIL_DELAY_MS;
    const maxDetails = config.max_details || DEFAULT_MAX_DETAILS;
    const totalTimeout = config.total_timeout || DEFAULT_TOTAL_TIMEOUT;
    const startTime = Date.now();

    console.log(`[mcexpocomfortMiner] Starting for: ${url} (timeout: ${totalTimeout}ms)`);

    // Total timeout wrapper
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`mcexpocomfortMiner total timeout (${totalTimeout}ms)`)), totalTimeout)
    );

    // Phase 1: Scroll and collect all exhibitor links + names
    const exhibitorCards = await Promise.race([
        collectExhibitorLinks(page, url, config),
        timeoutPromise
    ]);

    if (exhibitorCards.length === 0) {
        console.log('[mcexpocomfortMiner] No exhibitor links found — returning empty.');
        return [];
    }

    // Phase 2: Visit detail pages to extract emails
    const detailLimit = Math.min(exhibitorCards.length, maxDetails);
    console.log(`[mcexpocomfortMiner] Phase 2: Visiting ${detailLimit} detail pages...`);

    let consecutiveErrors = 0;
    let enriched = 0;

    for (let i = 0; i < detailLimit; i++) {
        // Timeout check
        if (Date.now() - startTime > totalTimeout) {
            console.log(`[mcexpocomfortMiner] Total timeout at ${i}/${detailLimit} — stopping.`);
            break;
        }

        // Consecutive error circuit breaker
        if (consecutiveErrors >= 5) {
            console.log(`[mcexpocomfortMiner] 5 consecutive errors — stopping detail crawl.`);
            break;
        }

        const card = exhibitorCards[i];
        const detail = await extractDetailPage(page, card.detail_url, detailDelay);

        if (!detail) {
            consecutiveErrors++;
            continue;
        }

        consecutiveErrors = 0;

        // Enrich the card
        if (detail.emails.length > 0) {
            card.email = detail.emails[0];
            card.all_emails = detail.emails;
            enriched++;
        }
        if (detail.phones.length > 0) card.phone = detail.phones[0];
        if (detail.website) card.website = detail.website;
        if (detail.address) card.address = detail.address;
        if (detail.country) card.country = detail.country || card.country;
        if (detail.contact_name) card.contact_name = detail.contact_name;
        if (detail.job_title) card.job_title = detail.job_title;

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
