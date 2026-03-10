/**
 * LIFFY MCE Expocomfort Miner v2.0
 * ==================================
 *
 * Specialized miner for mcexpocomfort.it exhibitor directory.
 *
 * Two-phase pipeline:
 *   1. Infinite scroll — scroll the list page, collect exhibitor detail URLs
 *      and extract organisationGuid from each URL pattern
 *   2. ReedExpo API — fetch email/contact data via REST API (no Playwright needed)
 *
 * Phase 2 uses two API endpoints per organisation:
 *   - GET /v1/documents/public?organisationGuid=GUID&eventEditionId=EVE_ID
 *   - GET /v1/event-editions/EVE_ID/organisations/GUID
 *
 * Miner contract:
 *   - Returns raw card data only (no normalization, no DB writes)
 *   - Browser lifecycle managed by flowOrchestrator wrapper
 *   - Handles its own pagination internally (ownPagination: true, ownBrowser: true)
 */

// ─── Constants ───────────────────────────────────────────────────────

const REED_API_BASE = 'https://api.reedexpo.com/v1';
const MCE_EVENT_EDITION_ID = 'eve-57a81c89-bb6c-4549-9448-a711fe3e7d22';

// Pattern: exhib_profile.COMPANY_NAME.org-GUID.html → extract "org-GUID"
const ORG_GUID_REGEX = /exhib_profile\.[^.]+\.(org-[a-f0-9\-]+)\.html/i;

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
const DEFAULT_CONCURRENCY = 5;

// ─── Phase 1: Infinite Scroll — Collect Links + Extract GUIDs ────────

/**
 * Scroll the page to the bottom repeatedly until no new content loads.
 * Returns array of { detail_url, company_name, country, org_guid }.
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

    // Extract organisationGuid from each detail URL
    for (const card of cardData) {
        const match = card.detail_url.match(ORG_GUID_REGEX);
        if (match) {
            card.org_guid = match[1];
        } else {
            card.org_guid = null;
        }
    }

    const withGuid = cardData.filter(c => c.org_guid).length;
    console.log(`[mcexpocomfortMiner] Phase 1 complete: ${cardData.length} exhibitors, ${withGuid} with GUID`);

    return cardData;
}

// ─── Phase 2: ReedExpo API — Email Extraction ────────────────────────

/**
 * Fetch organisation data from ReedExpo API.
 * Tries two endpoints and merges results.
 */
async function fetchOrgFromAPI(orgGuid, eventEditionId) {
    const results = {
        emails: [],
        phones: [],
        website: null,
        address: null,
        country: null,
        contact_name: null,
        job_title: null,
        description: null
    };

    // Endpoint 1: Documents/public — general organisation info
    try {
        const docsUrl = `${REED_API_BASE}/documents/public?organisationGuid=${orgGuid}&eventEditionId=${eventEditionId}`;
        const docsRes = await fetch(docsUrl, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(10000)
        });

        if (docsRes.ok) {
            const docsData = await docsRes.json();
            extractFromDocsResponse(docsData, results);
        }
    } catch (e) {
        // Endpoint 1 failed — continue to endpoint 2
    }

    // Endpoint 2: Event-editions/organisations — detailed org profile
    try {
        const orgUrl = `${REED_API_BASE}/event-editions/${eventEditionId}/organisations/${orgGuid}`;
        const orgRes = await fetch(orgUrl, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(10000)
        });

        if (orgRes.ok) {
            const orgData = await orgRes.json();
            extractFromOrgResponse(orgData, results);
        }
    } catch (e) {
        // Endpoint 2 failed
    }

    // Deduplicate emails
    results.emails = [...new Set(results.emails)];

    return results;
}

/**
 * Extract contact info from /documents/public response.
 */
function extractFromDocsResponse(data, results) {
    if (!data) return;

    // Handle array or single object
    const items = Array.isArray(data) ? data : [data];

    for (const item of items) {
        // Email fields
        extractEmailFromField(item.email, results);
        extractEmailFromField(item.emailAddress, results);
        extractEmailFromField(item.contactEmail, results);

        // Nested contact object
        if (item.contact) {
            extractEmailFromField(item.contact.email, results);
            extractEmailFromField(item.contact.emailAddress, results);
            if (item.contact.phone) results.phones.push(item.contact.phone);
            if (item.contact.firstName || item.contact.lastName) {
                results.contact_name = [item.contact.firstName, item.contact.lastName].filter(Boolean).join(' ');
            }
            if (item.contact.jobTitle) results.job_title = item.contact.jobTitle;
        }

        // Phone
        if (item.phone && !results.phones.includes(item.phone)) results.phones.push(item.phone);
        if (item.telephone && !results.phones.includes(item.telephone)) results.phones.push(item.telephone);

        // Website
        if (item.website && !results.website) results.website = item.website;
        if (item.websiteUrl && !results.website) results.website = item.websiteUrl;
        if (item.url && !results.website) results.website = item.url;

        // Address
        if (item.address && !results.address) {
            results.address = typeof item.address === 'string'
                ? item.address
                : [item.address.street, item.address.city, item.address.postCode, item.address.country].filter(Boolean).join(', ');
        }

        // Country
        if (item.country && !results.country) results.country = item.country;
        if (item.address && item.address.country && !results.country) results.country = item.address.country;

        // Description
        if (item.description && !results.description) results.description = item.description;
        if (item.companyDescription && !results.description) results.description = item.companyDescription;

        // Scan full text for emails
        const jsonStr = JSON.stringify(item);
        const foundEmails = jsonStr.match(EMAIL_REGEX) || [];
        for (const email of foundEmails) {
            extractEmailFromField(email, results);
        }
    }
}

/**
 * Extract contact info from /event-editions/.../organisations/... response.
 */
function extractFromOrgResponse(data, results) {
    if (!data) return;

    // Direct fields
    extractEmailFromField(data.email, results);
    extractEmailFromField(data.emailAddress, results);
    extractEmailFromField(data.contactEmail, results);

    // Phone
    if (data.phone && !results.phones.includes(data.phone)) results.phones.push(data.phone);
    if (data.telephone && !results.phones.includes(data.telephone)) results.phones.push(data.telephone);
    if (data.phoneNumber && !results.phones.includes(data.phoneNumber)) results.phones.push(data.phoneNumber);

    // Website
    if (data.website && !results.website) results.website = data.website;
    if (data.websiteUrl && !results.website) results.website = data.websiteUrl;
    if (data.companyWebsite && !results.website) results.website = data.companyWebsite;

    // Address
    if (data.address && !results.address) {
        results.address = typeof data.address === 'string'
            ? data.address
            : [data.address.addressLine1, data.address.addressLine2, data.address.city, data.address.postCode, data.address.country].filter(Boolean).join(', ');
    }

    // Country
    if (data.country && !results.country) results.country = data.country;
    if (data.countryName && !results.country) results.country = data.countryName;
    if (data.address && data.address.country && !results.country) results.country = data.address.country;

    // Contact person
    if (data.contacts && Array.isArray(data.contacts) && data.contacts.length > 0) {
        const contact = data.contacts[0];
        extractEmailFromField(contact.email, results);
        extractEmailFromField(contact.emailAddress, results);
        if (contact.phone && !results.phones.includes(contact.phone)) results.phones.push(contact.phone);
        if (contact.firstName || contact.lastName) {
            if (!results.contact_name) {
                results.contact_name = [contact.firstName, contact.lastName].filter(Boolean).join(' ');
            }
        }
        if (contact.jobTitle && !results.job_title) results.job_title = contact.jobTitle;
    }

    // Description
    if (data.description && !results.description) results.description = data.description;
    if (data.companyProfile && !results.description) results.description = data.companyProfile;

    // Scan full text for emails
    const jsonStr = JSON.stringify(data);
    const foundEmails = jsonStr.match(EMAIL_REGEX) || [];
    for (const email of foundEmails) {
        extractEmailFromField(email, results);
    }
}

/**
 * Validate and add email to results, filtering junk domains.
 */
function extractEmailFromField(value, results) {
    if (!value || typeof value !== 'string') return;
    const email = value.trim().toLowerCase();
    if (!email.includes('@') || email.length < 6) return;
    if (results.emails.includes(email)) return;

    const isJunk = JUNK_EMAIL_DOMAINS.some(d => email.endsWith('@' + d) || email.includes('.' + d));
    if (isJunk) return;

    results.emails.push(email);
}

/**
 * Process a batch of cards concurrently via API.
 */
async function processBatch(batch, eventEditionId) {
    return Promise.all(batch.map(async (card) => {
        if (!card.org_guid) return null;

        try {
            const data = await fetchOrgFromAPI(card.org_guid, eventEditionId);
            return { card, data };
        } catch (e) {
            console.warn(`[mcexpocomfortMiner] API error for ${card.org_guid}: ${e.message}`);
            return null;
        }
    }));
}

// ─── Main Entry Point ────────────────────────────────────────────────

async function runMcexpocomfortMiner(page, url, config = {}) {
    const maxDetails = config.max_details || DEFAULT_MAX_DETAILS;
    const concurrency = config.concurrency || DEFAULT_CONCURRENCY;
    const totalTimeout = config.total_timeout || DEFAULT_TOTAL_TIMEOUT;
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

    // Filter to cards with GUIDs only, limit to maxDetails
    const cardsWithGuid = exhibitorCards.filter(c => c.org_guid);
    const cardsToProcess = cardsWithGuid.slice(0, maxDetails);

    console.log(`[mcexpocomfortMiner] Phase 2: Fetching ${cardsToProcess.length} orgs via ReedExpo API (concurrency: ${concurrency})...`);

    // Phase 2: Fetch data from API in batches
    let enriched = 0;
    let apiErrors = 0;

    for (let i = 0; i < cardsToProcess.length; i += concurrency) {
        // Timeout check
        if (Date.now() - startTime > totalTimeout) {
            console.log(`[mcexpocomfortMiner] Total timeout at ${i}/${cardsToProcess.length} — stopping.`);
            break;
        }

        const batch = cardsToProcess.slice(i, i + concurrency);
        const results = await processBatch(batch, eventEditionId);

        for (const result of results) {
            if (!result) {
                apiErrors++;
                continue;
            }

            const { card, data } = result;

            if (data.emails.length > 0) {
                card.email = data.emails[0];
                card.all_emails = data.emails;
                enriched++;
            }
            if (data.phones.length > 0) card.phone = data.phones[0];
            if (data.website) card.website = data.website;
            if (data.address) card.address = data.address;
            if (data.country) card.country = data.country || card.country;
            if (data.contact_name) card.contact_name = data.contact_name;
            if (data.job_title) card.job_title = data.job_title;
        }

        // Progress log every 50 orgs
        const processed = Math.min(i + concurrency, cardsToProcess.length);
        if (processed % 50 === 0 || processed === cardsToProcess.length) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            console.log(`[mcexpocomfortMiner] API progress: ${processed}/${cardsToProcess.length}, +${enriched} emails, ${apiErrors} errors (${elapsed}s)`);
        }
    }

    console.log(`[mcexpocomfortMiner] Phase 2 complete: ${enriched} emails from ${cardsToProcess.length} API calls, ${apiErrors} errors`);

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
