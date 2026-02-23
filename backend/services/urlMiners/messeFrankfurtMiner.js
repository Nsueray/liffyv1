/**
 * LIFFY Messe Frankfurt Miner v1.0
 * ==================================
 *
 * Specialized miner for Messe Frankfurt exhibition exhibitor catalogs.
 * Covers all events: Techtextil, Automechanika, Heimtextil, ISH, etc.
 *
 * Two-phase pipeline:
 *   1. List page — intercept exhibitor search API (api.messefrankfurt.com)
 *      OR discover the API endpoint via network sniffing, then paginate
 *   2. Detail pages — visit each exhibitor detail URL, extract from DOM
 *
 * Miner contract:
 *   - Returns raw card data only (no normalization, no DB writes)
 *   - Browser lifecycle managed by flowOrchestrator wrapper
 *   - Handles its own pagination internally (ownPagination: true)
 *
 * Usage (module only):
 *   const { runMesseFrankfurtMiner } = require("./messeFrankfurtMiner");
 *   const cards = await runMesseFrankfurtMiner(page, url, config);
 */

// ─── Constants ───────────────────────────────────────────────────────

const SOCIAL_HOSTS = [
    "facebook.com", "twitter.com", "linkedin.com", "instagram.com",
    "youtube.com", "pinterest.com", "tiktok.com", "x.com",
    "xing.com", "wa.me", "line.me", "vimeo.com"
];

const SKIP_DOMAINS = [
    "messefrankfurt.com",
    ...SOCIAL_HOSTS
];

const EMAIL_REGEX = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;

const MAX_PAGES = 50;
const MAX_DETAILS = 300;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_DELAY_MS = 1500;

// ─── Phase 1: List Page — API Discovery & Pagination ─────────────────

/**
 * Try to extract the event variable from the URL or page.
 * Messe Frankfurt URLs look like:
 *   https://techtextil.messefrankfurt.com/frankfurt/en/exhibitor-search.html
 * The subdomain (techtextil) is usually the event variable.
 */
function extractEventVariable(url) {
    try {
        const u = new URL(url);
        const hostname = u.hostname.toLowerCase();
        // subdomain before .messefrankfurt.com
        const parts = hostname.split('.');
        if (parts.length >= 3 && parts[parts.length - 2] === 'messefrankfurt') {
            const subdomain = parts[0].toUpperCase();
            // Some events have multi-word subdomains
            if (subdomain && subdomain !== 'WWW' && subdomain !== 'API') {
                return subdomain;
            }
        }
    } catch (e) { /* ignore */ }
    return null;
}

/**
 * Derive the base URL for detail pages from the input URL.
 * Input:  https://techtextil.messefrankfurt.com/frankfurt/en/exhibitor-search.html?page=1
 * Output: https://techtextil.messefrankfurt.com/frankfurt/en
 */
function deriveBaseUrl(url) {
    try {
        const u = new URL(url);
        const path = u.pathname;
        // Remove exhibitor-search.html and anything after
        const idx = path.indexOf('/exhibitor-search');
        if (idx !== -1) {
            return `${u.origin}${path.substring(0, idx)}`;
        }
        // Fallback: remove last segment
        const lastSlash = path.lastIndexOf('/');
        return `${u.origin}${path.substring(0, lastSlash)}`;
    } catch (e) {
        return url;
    }
}

/**
 * Discover the exhibitor search API endpoint by intercepting network requests
 * while the page loads.
 */
async function discoverApiEndpoint(page, url, timeoutMs = 15000) {
    let apiUrl = null;
    let apiResponse = null;

    const responseHandler = async (response) => {
        if (apiUrl) return; // Already found
        try {
            const respUrl = response.url();
            const contentType = response.headers()['content-type'] || '';

            // Look for the exhibitor search API call
            if (!contentType.includes('json')) return;
            if (response.status() < 200 || response.status() >= 400) return;

            // Match known Messe Frankfurt API patterns
            const isExhibitorApi = (
                respUrl.includes('exhibitor-service') ||
                respUrl.includes('exhibitor/search') ||
                (respUrl.includes('api.messefrankfurt.com') && respUrl.includes('search'))
            );

            if (!isExhibitorApi) return;

            const text = await response.text().catch(() => null);
            if (!text || text.length < 100) return;

            try {
                const body = JSON.parse(text);
                // Messe Frankfurt API returns { success: true, result: { hits: [...] } }
                if (body.result && Array.isArray(body.result.hits) && body.result.hits.length > 0) {
                    apiUrl = respUrl;
                    apiResponse = body;
                    console.log(`[messeFrankfurtMiner] API discovered: ${respUrl.substring(0, 120)}...`);
                }
            } catch (e) { /* not JSON */ }
        } catch (e) { /* ignore response read errors */ }
    };

    page.on('response', responseHandler);

    try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        // Give extra time for API calls to complete
        await page.waitForTimeout(3000);
    } catch (e) {
        console.warn(`[messeFrankfurtMiner] Navigation warning: ${e.message}`);
    }

    page.off('response', responseHandler);

    return { apiUrl, apiResponse };
}

/**
 * Build the API search URL for a given page number.
 */
function buildApiUrl(baseApiUrl, eventVariable, pageNumber, pageSize) {
    // If we discovered the API URL, modify its page number
    if (baseApiUrl) {
        try {
            const u = new URL(baseApiUrl);
            u.searchParams.set('pageNumber', String(pageNumber));
            u.searchParams.set('pageSize', String(pageSize));
            return u.toString();
        } catch (e) { /* fall through */ }
    }

    // Fallback: construct from known API pattern
    const base = 'https://api.messefrankfurt.com/service/esb_api/exhibitor-service/api/2.1/public/exhibitor/search';
    const params = new URLSearchParams({
        language: 'en-GB',
        q: '',
        orderBy: 'name',
        pageNumber: String(pageNumber),
        pageSize: String(pageSize),
        showJumpLabels: 'false'
    });
    if (eventVariable) {
        params.set('findEventVariable', eventVariable);
    }
    return `${base}?${params.toString()}`;
}

/**
 * Extract exhibitor list items from API response.
 * Returns array of { name, rewriteId }.
 */
function parseExhibitorHits(apiResponse) {
    const hits = [];
    try {
        const rawHits = apiResponse?.result?.hits || [];
        for (const hit of rawHits) {
            const exhibitor = hit?.exhibitor || hit;
            const name = exhibitor?.name || exhibitor?.companyName || null;
            const rewriteId = exhibitor?.rewriteId || exhibitor?.id || null;

            if (name && rewriteId) {
                hits.push({ name: name.trim(), rewriteId: String(rewriteId) });
            }
        }
    } catch (e) {
        console.warn(`[messeFrankfurtMiner] Hit parsing error: ${e.message}`);
    }
    return hits;
}

/**
 * Phase 1: Fetch all exhibitors via paginated API calls.
 */
async function fetchAllExhibitors(page, url, config) {
    const pageSize = config.page_size || DEFAULT_PAGE_SIZE;
    const maxPages = config.max_pages || MAX_PAGES;
    const eventVariable = extractEventVariable(url);

    console.log(`[messeFrankfurtMiner] Phase 1: List page. Event: ${eventVariable || 'unknown'}`);

    // Step 1: Discover API endpoint by loading the page
    const { apiUrl: discoveredApiUrl, apiResponse: firstResponse } = await discoverApiEndpoint(page, url);

    let allExhibitors = [];
    let baseApiUrl = discoveredApiUrl;

    // If we got the first page from network sniffing, use it
    if (firstResponse) {
        const firstHits = parseExhibitorHits(firstResponse);
        allExhibitors.push(...firstHits);
        console.log(`[messeFrankfurtMiner] Page 1 (sniffed): ${firstHits.length} exhibitors`);

        if (firstHits.length < pageSize) {
            console.log(`[messeFrankfurtMiner] Single page result (${allExhibitors.length} total)`);
            return allExhibitors;
        }
    }

    // Step 2: Paginate through remaining pages via fetch in browser context
    const startPage = firstResponse ? 2 : 1;

    for (let pageNum = startPage; pageNum <= maxPages; pageNum++) {
        const apiPageUrl = buildApiUrl(baseApiUrl, eventVariable, pageNum, pageSize);

        try {
            const result = await page.evaluate(async (fetchUrl) => {
                try {
                    const resp = await fetch(fetchUrl, {
                        headers: { 'Accept': 'application/json' },
                        credentials: 'include'
                    });
                    if (!resp.ok) return { error: resp.status };
                    return { data: await resp.json() };
                } catch (e) {
                    return { error: e.message };
                }
            }, apiPageUrl);

            if (result.error) {
                console.warn(`[messeFrankfurtMiner] Page ${pageNum} fetch error: ${result.error}`);
                break;
            }

            const hits = parseExhibitorHits(result.data);
            if (hits.length === 0) {
                console.log(`[messeFrankfurtMiner] Page ${pageNum}: empty — done.`);
                break;
            }

            allExhibitors.push(...hits);
            console.log(`[messeFrankfurtMiner] Page ${pageNum}: ${hits.length} exhibitors (total: ${allExhibitors.length})`);

            // Small delay between API calls
            await page.waitForTimeout(300 + Math.floor(Math.random() * 200));
        } catch (e) {
            console.warn(`[messeFrankfurtMiner] Page ${pageNum} error: ${e.message}`);
            break;
        }
    }

    console.log(`[messeFrankfurtMiner] Phase 1 complete: ${allExhibitors.length} exhibitors found`);
    return allExhibitors;
}

// ─── Phase 2: Detail Pages — DOM Extraction ──────────────────────────

/**
 * Extract exhibitor data from a detail page.
 */
async function extractDetailPage(page, detailUrl, delayMs) {
    try {
        await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 20000 });
        await page.waitForTimeout(1000);

        const data = await page.evaluate((skipDomains) => {
            const result = {
                emails: [],
                phones: [],
                website: null,
                address: null,
                country: null
            };

            // Emails: real mailto: links (filter out share/contact form links)
            const mailtoLinks = document.querySelectorAll('a[href^="mailto:"]');
            for (const a of mailtoLinks) {
                const href = a.getAttribute('href') || '';
                // Skip "mailto:?subject=" share links
                if (href.startsWith('mailto:?')) continue;
                const email = href.replace('mailto:', '').split('?')[0].trim().toLowerCase();
                if (email && email.includes('@') && email.length > 5) {
                    result.emails.push(email);
                }
            }

            // Phones: tel: links
            const telLinks = document.querySelectorAll('a[href^="tel:"]');
            for (const a of telLinks) {
                const href = a.getAttribute('href') || '';
                const phone = href.replace('tel:', '').trim();
                if (phone && phone.replace(/\D/g, '').length >= 7) {
                    result.phones.push(phone);
                }
            }

            // Website: external links (skip social, skip messefrankfurt)
            const allAnchors = document.querySelectorAll('a[href^="http"]');
            for (const a of allAnchors) {
                const href = (a.getAttribute('href') || '').trim();
                if (!href) continue;

                let skip = false;
                for (const domain of skipDomains) {
                    if (href.toLowerCase().includes(domain)) {
                        skip = true;
                        break;
                    }
                }
                if (skip) continue;

                const target = a.getAttribute('target') || '';
                const text = (a.textContent || '').trim().toLowerCase();
                const parentText = (a.parentElement?.textContent || '').toLowerCase();

                if (
                    target === '_blank' ||
                    text.includes('website') ||
                    text.includes('visit') ||
                    text.includes('www') ||
                    parentText.includes('website') ||
                    parentText.includes('homepage')
                ) {
                    result.website = href;
                    break;
                }
            }

            // Address: look for address containers
            const addressSelectors = [
                '.exhibitor-address', '[class*="address"]',
                '.exhibitor-location', '[class*="location"]',
                '.address', '.adr'
            ];
            for (const sel of addressSelectors) {
                try {
                    const el = document.querySelector(sel);
                    if (el && el.innerText && el.innerText.trim().length > 10) {
                        const addrText = el.innerText.trim().replace(/\s+/g, ' ');
                        result.address = addrText;
                        // Country: typically last line/word in address
                        const lines = addrText.split(/\n|,/).map(l => l.trim()).filter(Boolean);
                        if (lines.length > 0) {
                            result.country = lines[lines.length - 1].trim();
                        }
                        break;
                    }
                } catch (e) { /* selector failed */ }
            }

            return result;
        }, SKIP_DOMAINS);

        // Polite delay
        await page.waitForTimeout(delayMs);

        return data;
    } catch (e) {
        console.warn(`[messeFrankfurtMiner] Detail page error (${detailUrl}): ${e.message}`);
        return null;
    }
}

// ─── Main Entry Point ────────────────────────────────────────────────

async function runMesseFrankfurtMiner(page, url, config = {}) {
    const delayMs = config.delay_ms || DEFAULT_DELAY_MS;
    const maxDetails = config.max_details || MAX_DETAILS;
    const startTime = Date.now();
    const totalTimeout = config.total_timeout || 480000; // 8 minutes

    console.log(`[messeFrankfurtMiner] Starting for: ${url}`);

    // Phase 1: Get all exhibitors from API
    const exhibitors = await fetchAllExhibitors(page, url, config);

    if (exhibitors.length === 0) {
        console.log('[messeFrankfurtMiner] No exhibitors found — returning empty.');
        return [];
    }

    // Phase 2: Visit detail pages
    const baseUrl = deriveBaseUrl(url);
    const cards = [];
    const detailLimit = Math.min(exhibitors.length, maxDetails);

    console.log(`[messeFrankfurtMiner] Phase 2: Detail pages (${detailLimit} of ${exhibitors.length})`);

    let consecutiveErrors = 0;

    for (let i = 0; i < detailLimit; i++) {
        // Timeout guard
        if (Date.now() - startTime > totalTimeout) {
            console.log(`[messeFrankfurtMiner] Timeout reached at ${i}/${detailLimit} — stopping.`);
            break;
        }

        // Consecutive error guard
        if (consecutiveErrors >= 5) {
            console.log(`[messeFrankfurtMiner] 5 consecutive errors — stopping detail crawl.`);
            break;
        }

        const exhibitor = exhibitors[i];
        const detailUrl = `${baseUrl}/exhibitor-search.detail.html/${exhibitor.rewriteId}`;

        const detail = await extractDetailPage(page, detailUrl, delayMs);

        if (!detail) {
            consecutiveErrors++;
            cards.push({
                company_name: exhibitor.name,
                email: null,
                phone: null,
                website: null,
                country: null,
                address: null,
                contact_name: null,
                job_title: null
            });
            continue;
        }

        consecutiveErrors = 0;

        cards.push({
            company_name: exhibitor.name,
            email: detail.emails[0] || null,
            phone: detail.phones[0] || null,
            website: detail.website || null,
            country: detail.country || null,
            address: detail.address || null,
            contact_name: null,
            job_title: null
        });

        if ((i + 1) % 25 === 0) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            console.log(`[messeFrankfurtMiner] Progress: ${i + 1}/${detailLimit} (${elapsed}s elapsed)`);
        }
    }

    const withEmail = cards.filter(c => c.email).length;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[messeFrankfurtMiner] Done: ${cards.length} cards, ${withEmail} with email (${elapsed}s)`);

    return cards;
}

// ─── Exports ─────────────────────────────────────────────────────────

module.exports = { runMesseFrankfurtMiner };
