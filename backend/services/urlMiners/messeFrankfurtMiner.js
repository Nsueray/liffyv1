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
    "messelogo.de",
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
 * Extract full exhibitor cards from API response.
 * The Messe Frankfurt API returns rich data: address, email, phone, homepage, country.
 * Returns array of full card objects.
 */
function parseExhibitorHits(apiResponse) {
    const hits = [];
    try {
        const rawHits = apiResponse?.result?.hits || [];
        for (const hit of rawHits) {
            const exhibitor = hit?.exhibitor || hit;
            const name = exhibitor?.name || exhibitor?.companyName || null;
            const rewriteId = exhibitor?.rewriteId || exhibitor?.id || null;

            if (!name) continue;

            const addr = exhibitor?.address || {};
            const country = addr?.country?.label || addr?.country?.iso3 || null;
            const addressParts = [addr.street, addr.zip, addr.city, country].filter(Boolean);

            hits.push({
                company_name: name.trim(),
                rewriteId: rewriteId ? String(rewriteId) : null,
                email: addr.email || null,
                phone: addr.tel || null,
                website: exhibitor.homepage || null,
                country: country,
                address: addressParts.length > 0 ? addressParts.join(' ') : null,
                contact_name: null,
                job_title: null
            });
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

        // Check total count from API response to decide if pagination needed
        const totalHits = firstResponse?.result?.totalHits
            || firstResponse?.result?.totalCount
            || firstResponse?.result?.total
            || null;

        console.log(`[messeFrankfurtMiner] Page 1 (sniffed): ${firstHits.length} exhibitors` +
            (totalHits ? ` (total: ${totalHits})` : ''));

        // Only skip pagination if we know we got everything
        if (totalHits !== null && allExhibitors.length >= totalHits) {
            console.log(`[messeFrankfurtMiner] All ${totalHits} exhibitors fetched in page 1`);
            return allExhibitors;
        }
        // If no total count, still paginate if we got a full page of results
        if (totalHits === null && firstHits.length === 0) {
            return allExhibitors;
        }
    }

    // Step 2: Paginate by navigating to successive search page URLs.
    // Direct fetch() fails due to CORS — navigating lets the SPA make its own API calls.
    const startPage = firstResponse ? 2 : 1;

    // Build page URL template from input URL
    const pageUrlBase = (() => {
        try {
            const u = new URL(url);
            u.searchParams.set('pagesize', String(pageSize));
            return u;
        } catch (e) {
            return null;
        }
    })();

    if (pageUrlBase) {
        for (let pageNum = startPage; pageNum <= maxPages; pageNum++) {
            try {
                let sniffedResponse = null;

                const responseHandler = async (response) => {
                    if (sniffedResponse) return;
                    try {
                        const respUrl = response.url();
                        const contentType = response.headers()['content-type'] || '';
                        if (!contentType.includes('json')) return;
                        if (response.status() < 200 || response.status() >= 400) return;

                        const isExhibitorApi = (
                            respUrl.includes('exhibitor-service') ||
                            respUrl.includes('exhibitor/search') ||
                            (respUrl.includes('api.messefrankfurt.com') && respUrl.includes('search'))
                        );
                        if (!isExhibitorApi) return;

                        const text = await response.text().catch(() => null);
                        if (!text || text.length < 100) return;
                        const body = JSON.parse(text);
                        if (body.result && Array.isArray(body.result.hits)) {
                            sniffedResponse = body;
                        }
                    } catch (e) { /* ignore */ }
                };

                page.on('response', responseHandler);

                pageUrlBase.searchParams.set('page', String(pageNum));
                await page.goto(pageUrlBase.toString(), { waitUntil: 'domcontentloaded', timeout: 20000 });
                await page.waitForTimeout(5000); // Wait for SPA to trigger API call

                page.off('response', responseHandler);

                if (!sniffedResponse) {
                    console.log(`[messeFrankfurtMiner] Page ${pageNum}: no API response — done.`);
                    break;
                }

                const hits = parseExhibitorHits(sniffedResponse);
                if (hits.length === 0) {
                    console.log(`[messeFrankfurtMiner] Page ${pageNum}: empty — done.`);
                    break;
                }

                allExhibitors.push(...hits);
                console.log(`[messeFrankfurtMiner] Page ${pageNum}: ${hits.length} exhibitors (total: ${allExhibitors.length})`);

                // Small delay between pages
                await page.waitForTimeout(500 + Math.floor(Math.random() * 500));
            } catch (e) {
                console.warn(`[messeFrankfurtMiner] Page ${pageNum} error: ${e.message}`);
                break;
            }
        }
    }

    console.log(`[messeFrankfurtMiner] Phase 1 complete: ${allExhibitors.length} exhibitors found`);
    return allExhibitors;
}

// ─── Phase 2: Detail Pages — DOM Extraction ──────────────────────────

/**
 * Extract exhibitor data from a detail page.
 * Strategy: Intercept API response (primary) + DOM extraction (fallback).
 */
async function extractDetailPage(page, detailUrl, delayMs) {
    try {
        // Strategy 1: Intercept the detail API response (SPA loads data via XHR)
        let apiData = null;

        const detailResponseHandler = async (response) => {
            if (apiData) return;
            try {
                const respUrl = response.url();
                const contentType = response.headers()['content-type'] || '';
                if (!contentType.includes('json')) return;
                if (response.status() < 200 || response.status() >= 400) return;

                // Match detail API calls (exhibitor detail endpoint)
                const isDetailApi = (
                    respUrl.includes('exhibitor-service') &&
                    !respUrl.includes('/search')
                ) || (
                    respUrl.includes('api.messefrankfurt.com') &&
                    respUrl.includes('exhibitor') &&
                    !respUrl.includes('search')
                );
                if (!isDetailApi) return;

                const text = await response.text().catch(() => null);
                if (!text || text.length < 50) return;
                apiData = JSON.parse(text);
            } catch (e) { /* ignore */ }
        };

        page.on('response', detailResponseHandler);

        await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        // Wait for SPA to load and trigger API + render DOM
        try {
            await page.waitForSelector('a[href^="mailto:"], a[href^="tel:"], [class*="exhibitor"], [class*="detail"]', { timeout: 8000 });
        } catch (e) {
            await page.waitForTimeout(4000);
        }

        page.off('response', detailResponseHandler);

        // Try to extract from API data first
        const result = { emails: [], phones: [], website: null, address: null, country: null };

        if (apiData) {
            // Messe Frankfurt detail API typically returns exhibitor object
            const exh = apiData?.result?.exhibitor || apiData?.result || apiData?.exhibitor || apiData;
            if (exh) {
                // Email from API
                const apiEmail = exh.email || exh.eMail || exh.emailAddress || null;
                if (apiEmail && apiEmail.includes('@')) result.emails.push(apiEmail.toLowerCase().trim());

                // Phone from API
                const apiPhone = exh.phone || exh.phoneNumber || exh.telephone || null;
                if (apiPhone) result.phones.push(apiPhone);

                // Website from API
                const apiWeb = exh.website || exh.url || exh.homepage || exh.web || null;
                if (apiWeb && apiWeb.startsWith('http')) result.website = apiWeb;

                // Address from API
                const parts = [exh.street, exh.zipCode || exh.zip, exh.city, exh.country].filter(Boolean);
                if (parts.length > 0) result.address = parts.join(' ');
                if (exh.country) result.country = exh.country;
                if (exh.countryName) result.country = exh.countryName;
            }
        }

        // Strategy 2: DOM extraction (fallback if API didn't provide data)
        const domData = await page.evaluate((skipDomains) => {
            const data = { emails: [], phones: [], website: null, address: null, country: null };

            // Emails: real mailto: links
            const mailtoLinks = document.querySelectorAll('a[href^="mailto:"]');
            for (const a of mailtoLinks) {
                const href = a.getAttribute('href') || '';
                if (href.startsWith('mailto:?')) continue;
                const email = href.replace('mailto:', '').split('?')[0].trim().toLowerCase();
                if (email && email.includes('@') && email.length > 5) {
                    data.emails.push(email);
                }
            }

            // Phones: tel: links
            const telLinks = document.querySelectorAll('a[href^="tel:"]');
            for (const a of telLinks) {
                const href = a.getAttribute('href') || '';
                const phone = href.replace('tel:', '').trim();
                if (phone && phone.replace(/\D/g, '').length >= 7) {
                    data.phones.push(phone);
                }
            }

            // Website: external links — strict matching (only near "website" labels)
            const allAnchors = document.querySelectorAll('a[href^="http"]');
            for (const a of allAnchors) {
                const href = (a.getAttribute('href') || '').trim();
                if (!href) continue;

                let skip = false;
                for (const domain of skipDomains) {
                    if (href.toLowerCase().includes(domain)) { skip = true; break; }
                }
                if (skip) continue;

                // Only pick links that are clearly labeled as website
                const text = (a.textContent || '').trim().toLowerCase();
                const parentText = (a.parentElement?.textContent || '').toLowerCase();
                const grandParentText = (a.parentElement?.parentElement?.textContent || '').toLowerCase();

                const isWebsiteLink = (
                    text.includes('website') || text.includes('www.') || text.includes('homepage') ||
                    parentText.includes('website') || parentText.includes('homepage') ||
                    grandParentText.includes('website:')
                );

                if (isWebsiteLink) {
                    data.website = href;
                    break;
                }
            }

            // Address
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
                        data.address = addrText;
                        const lines = addrText.split(/\n|,/).map(l => l.trim()).filter(Boolean);
                        if (lines.length > 0) {
                            data.country = lines[lines.length - 1].trim();
                        }
                        break;
                    }
                } catch (e) { /* selector failed */ }
            }

            return data;
        }, SKIP_DOMAINS);

        // Merge: API data wins, DOM fills gaps
        if (result.emails.length === 0 && domData.emails.length > 0) result.emails = domData.emails;
        if (result.phones.length === 0 && domData.phones.length > 0) result.phones = domData.phones;
        if (!result.website && domData.website) result.website = domData.website;
        if (!result.address && domData.address) result.address = domData.address;
        if (!result.country && domData.country) result.country = domData.country;

        // Polite delay
        await page.waitForTimeout(delayMs);

        return result;
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

    // The API returns full data (email, phone, homepage, address, country).
    // Use API data directly — only visit detail pages for exhibitors missing email.
    const withEmailFromApi = exhibitors.filter(e => e.email).length;
    console.log(`[messeFrankfurtMiner] API data: ${exhibitors.length} exhibitors, ${withEmailFromApi} with email`);

    // Phase 2: Visit detail pages ONLY for exhibitors missing email
    const missingEmail = exhibitors.filter(e => !e.email && e.rewriteId);
    const detailLimit = Math.min(missingEmail.length, maxDetails);
    const baseUrl = deriveBaseUrl(url);

    if (detailLimit > 0) {
        console.log(`[messeFrankfurtMiner] Phase 2: Detail pages for ${detailLimit} exhibitors missing email`);

        let consecutiveErrors = 0;
        let enriched = 0;

        for (let i = 0; i < detailLimit; i++) {
            if (Date.now() - startTime > totalTimeout) {
                console.log(`[messeFrankfurtMiner] Timeout at ${i}/${detailLimit} — stopping.`);
                break;
            }
            if (consecutiveErrors >= 5) {
                console.log(`[messeFrankfurtMiner] 5 consecutive errors — stopping detail crawl.`);
                break;
            }

            const exhibitor = missingEmail[i];
            // Correct URL format: rewriteId.html (not bare rewriteId)
            const detailUrl = `${baseUrl}/exhibitor-search.detail.html/${exhibitor.rewriteId}.html`;

            const detail = await extractDetailPage(page, detailUrl, delayMs);

            if (!detail) {
                consecutiveErrors++;
                continue;
            }

            consecutiveErrors = 0;

            // Enrich the original exhibitor card
            if (detail.emails.length > 0) { exhibitor.email = detail.emails[0]; enriched++; }
            if (!exhibitor.phone && detail.phones.length > 0) exhibitor.phone = detail.phones[0];
            if (!exhibitor.website && detail.website) exhibitor.website = detail.website;
            if (!exhibitor.address && detail.address) exhibitor.address = detail.address;
            if (!exhibitor.country && detail.country) exhibitor.country = detail.country;

            if ((i + 1) % 25 === 0) {
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                console.log(`[messeFrankfurtMiner] Detail progress: ${i + 1}/${detailLimit}, +${enriched} emails (${elapsed}s)`);
            }
        }

        console.log(`[messeFrankfurtMiner] Phase 2 complete: ${enriched} new emails from detail pages`);
    }

    // Build final cards (strip internal rewriteId field)
    const cards = exhibitors.map(e => ({
        company_name: e.company_name,
        email: e.email || null,
        phone: e.phone || null,
        website: e.website || null,
        country: e.country || null,
        address: e.address || null,
        contact_name: e.contact_name || null,
        job_title: e.job_title || null
    }));

    const withEmail = cards.filter(c => c.email).length;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[messeFrankfurtMiner] Done: ${cards.length} cards, ${withEmail} with email (${elapsed}s)`);

    return cards;
}

// ─── Exports ─────────────────────────────────────────────────────────

module.exports = { runMesseFrankfurtMiner };
