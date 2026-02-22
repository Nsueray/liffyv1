/**
 * LIFFY SPA Network Miner v1.0
 * =============================
 *
 * Generic miner for SPA / API-driven catalog sites.
 * Uses Playwright browser but does NOT extract from DOM.
 * Instead, intercepts network (XHR/fetch) responses and auto-detects
 * JSON payloads containing exhibitor/contact data.
 *
 * WHY Playwright instead of direct HTTP:
 *   - Browser opens the page → site handles its own login/auth (anonymous JWT etc.)
 *   - All API calls happen naturally as if a real user is browsing
 *   - No need to reverse-engineer auth endpoints per site
 *   - Invisible to bot detection — we ARE a real browser
 *
 * PHASES:
 *   1. List page — open URL, sniff network, find exhibitor array response
 *   2. Detail pages — navigate to each exhibitor detail, sniff for email endpoint
 *      (skipped if emails already present in list response)
 *   3. Output — return raw contact array (normalizeResult compatible)
 *
 * Usage (module only — browser lifecycle managed by flowOrchestrator wrapper):
 *   const { runSpaNetworkMiner } = require("./spaNetworkMiner");
 *   const cards = await runSpaNetworkMiner(page, url, config);
 */

// ─── Field Auto-Detection Patterns ──────────────────────────────────

const EMAIL_REGEX = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;

const FIELD_PATTERNS = {
  email:   { nameMatch: /email|mail|correo|e-?mail/i,   valueTest: (v) => typeof v === 'string' && EMAIL_REGEX.test(v.trim()) },
  company: { nameMatch: /name|company|firm|nombre|exhiname|razonsocial|empresa/i, valueTest: null },
  phone:   { nameMatch: /phone|tel|fax|telefono|movil|mobile/i,  valueTest: null },
  website: { nameMatch: /web|url|website|sitio|homepage/i, valueTest: null },
  contact: { nameMatch: /contact|person|contacto|contactperson|responsable/i, valueTest: null },
  country: { nameMatch: /country|pais|countryid|nationality|nacion/i, valueTest: null },
  address: { nameMatch: /address|direccion|domicilio|street|calle/i, valueTest: null },
  city:    { nameMatch: /city|ciudad|localidad|town/i, valueTest: null },
  title:   { nameMatch: /title|position|cargo|puesto|contactposition/i, valueTest: null },
  id:      { nameMatch: /^(id|pk|exhibitor|exhiid|exhi_id|exhibitorid|record_id)$/i, valueTest: null },
};

// ─── Helpers ────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Detect which field a JSON key maps to using name patterns.
 */
function detectFieldByName(key) {
  for (const [field, pattern] of Object.entries(FIELD_PATTERNS)) {
    if (pattern.nameMatch.test(key)) return field;
  }
  return null;
}

/**
 * Detect email fields by checking values (for fields whose name doesn't match).
 */
function detectEmailByValue(obj) {
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string' && EMAIL_REGEX.test(val.trim())) {
      return key;
    }
  }
  return null;
}

/**
 * Given a JSON object (one item from an array), build a field mapping.
 * Returns { email: 'exhiemail', company: 'exhiname', ... }
 */
function buildFieldMap(sampleItem) {
  const map = {};
  const keys = Object.keys(sampleItem);

  for (const key of keys) {
    const field = detectFieldByName(key);
    if (field && !map[field]) {
      map[field] = key;
    }
  }

  // If no email field found by name, try by value
  if (!map.email) {
    const emailKey = detectEmailByValue(sampleItem);
    if (emailKey) map.email = emailKey;
  }

  return map;
}

/**
 * Extract a contact object from a raw JSON item using a field map.
 */
function extractContact(item, fieldMap, sourceUrl) {
  const get = (field) => {
    const key = fieldMap[field];
    if (!key) return null;
    const val = item[key];
    if (val === null || val === undefined) return null;
    if (typeof val === 'string') return val.trim() || null;
    if (typeof val === 'object' && val.name) return val.name; // nested { name: "Italia" }
    return String(val);
  };

  return {
    company_name: get('company'),
    email: get('email'),
    contact_name: get('contact'),
    phone: get('phone'),
    website: get('website'),
    country: get('country'),
    address: get('address'),
    city: get('city'),
    job_title: get('title'),
    source_url: sourceUrl,
  };
}

/**
 * Score a JSON array to determine if it looks like an exhibitor/contact list.
 * Higher score = more likely.
 */
function scoreExhibitorArray(arr) {
  if (!Array.isArray(arr) || arr.length < 3) return 0;

  const sample = arr[0];
  if (!sample || typeof sample !== 'object') return 0;

  const keys = Object.keys(sample);
  let score = 0;

  // Array size bonus
  if (arr.length >= 5) score += 10;
  if (arr.length >= 20) score += 10;
  if (arr.length >= 50) score += 10;

  // Field name detection
  const fieldMap = buildFieldMap(sample);
  if (fieldMap.company) score += 30;
  if (fieldMap.email) score += 25;
  if (fieldMap.phone) score += 15;
  if (fieldMap.website) score += 15;
  if (fieldMap.country) score += 10;
  if (fieldMap.contact) score += 10;
  if (fieldMap.id) score += 5;

  // Check if multiple items have company-like values
  const companyKey = fieldMap.company;
  if (companyKey) {
    const filled = arr.filter(item => item[companyKey] && String(item[companyKey]).trim().length > 1).length;
    if (filled / arr.length > 0.5) score += 15;
  }

  return score;
}

/**
 * Extract arrays from a JSON response body (handles nested data/results/items keys).
 */
function extractArrays(body) {
  const results = [];

  if (Array.isArray(body)) {
    results.push({ path: 'root', array: body });
  }

  if (body && typeof body === 'object') {
    const dataKeys = ['data', 'results', 'items', 'records', 'rows', 'list', 'entries', 'exhibitors', 'companies'];
    for (const key of dataKeys) {
      if (Array.isArray(body[key]) && body[key].length > 0) {
        results.push({ path: key, array: body[key] });
      }
    }
  }

  return results;
}

// ─── Main Miner ─────────────────────────────────────────────────────

/**
 * Run the SPA Network Miner.
 *
 * @param {import('playwright').Page} page — Playwright page (browser already launched)
 * @param {string} url — Target URL
 * @param {Object} config — Job config { max_pages, delay_ms, ... }
 * @returns {Promise<Array>} Raw contact cards
 */
async function runSpaNetworkMiner(page, url, config = {}) {
  const delayMs = config.delay_ms || 1000;
  const maxDetails = config.max_details || 300;
  const totalTimeout = config.total_timeout || 600000; // 10 min
  const startTime = Date.now();

  console.log(`[spaNetworkMiner] Starting: ${url}`);
  console.log(`[spaNetworkMiner] Config: delay=${delayMs}ms, maxDetails=${maxDetails}`);

  // ========================================
  // PHASE 1: List page — network sniff
  // ========================================
  console.log('[spaNetworkMiner] Phase 1: Loading list page, sniffing network...');

  const jsonResponses = [];

  // Listen for ALL JSON responses
  const responseHandler = async (response) => {
    try {
      const respUrl = response.url();
      const contentType = response.headers()['content-type'] || '';

      // Only capture JSON from the same origin (or API endpoints)
      if (!contentType.includes('json') && !contentType.includes('javascript')) return;
      // Skip static assets
      if (/\.(js|css|png|jpg|svg|woff|ico)(\?|$)/i.test(respUrl)) return;
      // Skip analytics/tracking
      if (/google-analytics|gtag|facebook|hotjar|segment|mixpanel/i.test(respUrl)) return;

      const status = response.status();
      if (status < 200 || status >= 400) return;

      const text = await response.text().catch(() => null);
      if (!text || text.length < 50) return;

      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return; // Not valid JSON
      }

      jsonResponses.push({
        url: respUrl,
        method: response.request().method(),
        body,
        size: text.length,
      });
    } catch {
      // Ignore response read errors
    }
  };

  page.on('response', responseHandler);

  // Navigate to list page
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (err) {
    console.warn(`[spaNetworkMiner] Navigation warning: ${err.message}`);
    // Page may have loaded enough — continue
  }

  // Extra wait for late API calls
  await sleep(3000);

  console.log(`[spaNetworkMiner] Captured ${jsonResponses.length} JSON responses`);

  // ========================================
  // PHASE 1b: Find the exhibitor list
  // ========================================
  let bestList = null;
  let bestScore = 0;
  let bestFieldMap = null;
  let listHasEmail = false;

  for (const resp of jsonResponses) {
    const arrays = extractArrays(resp.body);

    for (const { path, array } of arrays) {
      if (array.length < 3) continue;

      const score = scoreExhibitorArray(array);

      if (score > bestScore) {
        bestScore = score;
        bestList = { url: resp.url, method: resp.method, path, array };
        bestFieldMap = buildFieldMap(array[0]);
      }
    }
  }

  if (!bestList || bestScore < 30) {
    console.log(`[spaNetworkMiner] No exhibitor list found (best score: ${bestScore})`);

    // Fallback: try scrolling for infinite scroll sites
    const scrollResult = await tryInfiniteScroll(page, jsonResponses);
    if (scrollResult) {
      bestList = scrollResult.bestList;
      bestScore = scrollResult.bestScore;
      bestFieldMap = scrollResult.bestFieldMap;
    }

    if (!bestList || bestScore < 30) {
      console.log('[spaNetworkMiner] Phase 1 failed — no exhibitor data found');
      return [];
    }
  }

  console.log(`[spaNetworkMiner] Found exhibitor list: ${bestList.array.length} items (score: ${bestScore})`);
  console.log(`[spaNetworkMiner] Source: ${bestList.method} ${bestList.url}`);
  console.log(`[spaNetworkMiner] Field map: ${JSON.stringify(bestFieldMap)}`);

  // Check if list already has emails
  listHasEmail = !!bestFieldMap.email;

  if (listHasEmail) {
    const emailCount = bestList.array.filter(item => {
      const val = item[bestFieldMap.email];
      return val && typeof val === 'string' && EMAIL_REGEX.test(val.trim());
    }).length;

    console.log(`[spaNetworkMiner] List has email field — ${emailCount}/${bestList.array.length} items have email`);

    if (emailCount > bestList.array.length * 0.3) {
      // Enough emails in list — skip Phase 2
      console.log('[spaNetworkMiner] Sufficient emails in list, skipping detail phase');

      const contacts = bestList.array.map(item => extractContact(item, bestFieldMap, url));
      console.log(`[spaNetworkMiner] Phase 1 complete: ${contacts.length} contacts (no detail needed)`);
      return contacts;
    }
  }

  // ========================================
  // PHASE 2: Detail pages — fetch email
  // ========================================
  console.log('[spaNetworkMiner] Phase 2: Fetching detail pages for email...');

  // Detect detail URL pattern from the list page URL
  const detailUrlPattern = detectDetailUrlPattern(url, bestList.array, bestFieldMap);

  if (!detailUrlPattern) {
    console.log('[spaNetworkMiner] Could not determine detail URL pattern — returning list data');
    const contacts = bestList.array.map(item => extractContact(item, bestFieldMap, url));
    return contacts;
  }

  console.log(`[spaNetworkMiner] Detail URL pattern: ${detailUrlPattern.template}`);
  console.log(`[spaNetworkMiner] Detail strategy: ${detailUrlPattern.strategy}`);

  // Collect detail data
  const detailDataMap = new Map(); // id -> detail JSON
  const itemsToProcess = bestList.array.slice(0, maxDetails);
  let detailApiPattern = null; // Will be detected from first few navigations

  // Strategy A: Browser navigation (first 5 items to learn the API pattern)
  const learnCount = Math.min(5, itemsToProcess.length);
  console.log(`[spaNetworkMiner] Learning API pattern from ${learnCount} detail navigations...`);

  for (let i = 0; i < learnCount; i++) {
    if (Date.now() - startTime > totalTimeout) {
      console.log('[spaNetworkMiner] Total timeout reached');
      break;
    }

    const item = itemsToProcess[i];
    const itemId = getItemId(item, bestFieldMap);

    if (!itemId) continue;

    const detailUrl = buildDetailUrl(detailUrlPattern, itemId);
    const detailResponses = [];

    const detailHandler = async (response) => {
      try {
        const respUrl = response.url();
        const contentType = response.headers()['content-type'] || '';
        if (!contentType.includes('json')) return;
        const status = response.status();
        if (status < 200 || status >= 300) return;

        const text = await response.text().catch(() => null);
        if (!text || text.length < 50) return;

        let body;
        try { body = JSON.parse(text); } catch { return; }

        // Look for detail-like responses (object with email-like fields)
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          const hasEmailIndicator = Object.keys(body).some(k => /email|mail|correo/i.test(k));
          const hasContactIndicator = Object.keys(body).some(k => /phone|tel|web|address|contact/i.test(k));

          if (hasEmailIndicator || hasContactIndicator) {
            detailResponses.push({ url: respUrl, body });
          }
        }
      } catch { /* ignore */ }
    };

    page.on('response', detailHandler);

    try {
      await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await sleep(2000);
    } catch (err) {
      console.warn(`[spaNetworkMiner] Detail navigation failed for ${itemId}: ${err.message}`);
    }

    page.off('response', detailHandler);

    if (detailResponses.length > 0) {
      // Pick the best detail response (most fields)
      const best = detailResponses.sort((a, b) =>
        Object.keys(b.body).length - Object.keys(a.body).length
      )[0];

      detailDataMap.set(String(itemId), best.body);

      // Learn the API pattern from the URL
      if (!detailApiPattern) {
        detailApiPattern = detectApiPattern(best.url, itemId);
        if (detailApiPattern) {
          console.log(`[spaNetworkMiner] Learned detail API pattern: ${detailApiPattern.template}`);
        }
      }
    }

    if (i < learnCount - 1) await sleep(delayMs);
  }

  // Strategy B: If we learned the API pattern, use fetch() in browser context for remaining items
  if (detailApiPattern && itemsToProcess.length > learnCount) {
    const remaining = itemsToProcess.slice(learnCount);
    console.log(`[spaNetworkMiner] Fetching ${remaining.length} details via browser fetch (fast path)...`);

    // Process in batches to avoid overwhelming the server
    const batchSize = 5;
    for (let batchStart = 0; batchStart < remaining.length; batchStart += batchSize) {
      if (Date.now() - startTime > totalTimeout) {
        console.log('[spaNetworkMiner] Total timeout reached during fast path');
        break;
      }

      const batch = remaining.slice(batchStart, batchStart + batchSize);

      const batchResults = await page.evaluate(async (params) => {
        const { items, apiTemplate, idField, delayMs } = params;
        const results = {};

        for (const item of items) {
          const itemId = item[idField];
          if (!itemId) continue;

          const apiUrl = apiTemplate.replace('{id}', itemId);

          try {
            const resp = await fetch(apiUrl, { credentials: 'include' });
            if (resp.ok) {
              const json = await resp.json();
              results[String(itemId)] = json;
            }
          } catch { /* ignore fetch errors */ }

          // Small delay between requests
          if (delayMs > 0) {
            await new Promise(r => setTimeout(r, delayMs));
          }
        }

        return results;
      }, {
        items: batch,
        apiTemplate: detailApiPattern.template,
        idField: bestFieldMap.id || 'id',
        delayMs: Math.max(200, delayMs / 2), // Faster in browser context
      });

      for (const [id, data] of Object.entries(batchResults)) {
        detailDataMap.set(id, data);
      }

      // Pause between batches
      await sleep(delayMs);

      const progress = Math.min(batchStart + batchSize, remaining.length);
      console.log(`[spaNetworkMiner] Detail progress: ${learnCount + progress}/${itemsToProcess.length}`);
    }
  } else if (!detailApiPattern && itemsToProcess.length > learnCount) {
    // No API pattern learned — continue with browser navigation (slow path)
    console.log(`[spaNetworkMiner] No API pattern learned, continuing browser navigation...`);

    for (let i = learnCount; i < itemsToProcess.length; i++) {
      if (Date.now() - startTime > totalTimeout) {
        console.log('[spaNetworkMiner] Total timeout reached');
        break;
      }

      const item = itemsToProcess[i];
      const itemId = getItemId(item, bestFieldMap);
      if (!itemId) continue;

      const detailUrl = buildDetailUrl(detailUrlPattern, itemId);
      const detailResponses = [];

      const detailHandler = async (response) => {
        try {
          const respUrl = response.url();
          const contentType = response.headers()['content-type'] || '';
          if (!contentType.includes('json')) return;
          const status = response.status();
          if (status < 200 || status >= 300) return;

          const text = await response.text().catch(() => null);
          if (!text || text.length < 50) return;

          let body;
          try { body = JSON.parse(text); } catch { return; }

          if (body && typeof body === 'object' && !Array.isArray(body)) {
            const hasIndicator = Object.keys(body).some(k => /email|phone|web|contact/i.test(k));
            if (hasIndicator) detailResponses.push({ url: respUrl, body });
          }
        } catch { /* ignore */ }
      };

      page.on('response', detailHandler);

      try {
        await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await sleep(2000);
      } catch { /* ignore */ }

      page.off('response', detailHandler);

      if (detailResponses.length > 0) {
        const best = detailResponses.sort((a, b) =>
          Object.keys(b.body).length - Object.keys(a.body).length
        )[0];
        detailDataMap.set(String(itemId), best.body);
      }

      if (i < itemsToProcess.length - 1) await sleep(delayMs);

      if ((i + 1) % 20 === 0) {
        console.log(`[spaNetworkMiner] Detail progress: ${i + 1}/${itemsToProcess.length}`);
      }
    }
  }

  console.log(`[spaNetworkMiner] Phase 2 complete: ${detailDataMap.size} detail responses collected`);

  // ========================================
  // PHASE 3: Merge list + detail data
  // ========================================
  console.log('[spaNetworkMiner] Phase 3: Merging list + detail data...');

  const contacts = [];

  for (const item of bestList.array) {
    const itemId = getItemId(item, bestFieldMap);
    const listContact = extractContact(item, bestFieldMap, url);

    // Merge with detail data if available
    if (itemId && detailDataMap.has(String(itemId))) {
      const detailData = detailDataMap.get(String(itemId));
      const detailFieldMap = buildFieldMap(detailData);
      const detailContact = extractContact(detailData, detailFieldMap, url);

      // Detail overwrites list for richer fields
      contacts.push({
        company_name: detailContact.company_name || listContact.company_name,
        email: detailContact.email || listContact.email,
        contact_name: detailContact.contact_name || listContact.contact_name,
        phone: detailContact.phone || listContact.phone,
        website: detailContact.website || listContact.website,
        country: detailContact.country || listContact.country,
        address: detailContact.address || listContact.address,
        city: detailContact.city || listContact.city,
        job_title: detailContact.job_title || listContact.job_title,
        source_url: url,
      });
    } else {
      contacts.push(listContact);
    }
  }

  const withEmail = contacts.filter(c => c.email).length;
  console.log(`[spaNetworkMiner] Final: ${contacts.length} contacts, ${withEmail} with email`);

  return contacts;
}

// ─── Detail URL Detection ───────────────────────────────────────────

/**
 * Detect the detail page URL pattern from the list page URL and item IDs.
 * Example: /catalog/cevisama/exhibitors → /catalog/cevisama/exhibitors/{id}
 */
function detectDetailUrlPattern(listUrl, items, fieldMap) {
  const idField = fieldMap.id;
  if (!idField) {
    // Try common ID field names
    const sample = items[0] || {};
    const idCandidates = ['id', 'pk', 'exhibitor', 'exhiid', 'exhibitorid', 'record_id', 'uid'];
    for (const key of idCandidates) {
      if (sample[key] !== undefined && sample[key] !== null) {
        fieldMap.id = key;
        break;
      }
    }
  }

  if (!fieldMap.id) return null;

  try {
    const parsed = new URL(listUrl);
    const basePath = parsed.pathname.replace(/\/$/, '');

    return {
      template: `${parsed.origin}${basePath}/{id}`,
      strategy: 'path_append',
    };
  } catch {
    return null;
  }
}

/**
 * Build a detail URL from a pattern and item ID.
 */
function buildDetailUrl(pattern, itemId) {
  return pattern.template.replace('{id}', itemId);
}

/**
 * Get the ID value from an item using the field map.
 */
function getItemId(item, fieldMap) {
  const key = fieldMap.id;
  if (!key) return null;
  const val = item[key];
  return val !== null && val !== undefined ? String(val) : null;
}

/**
 * Detect an API pattern from a detail response URL and the item ID.
 * Example: /api/exhibitor/get?exhiid=26429 → /api/exhibitor/get?exhiid={id}
 */
function detectApiPattern(apiUrl, itemId) {
  const idStr = String(itemId);

  // Check if ID is in URL (path or query)
  if (!apiUrl.includes(idStr)) return null;

  // Replace the ID with a placeholder
  const template = apiUrl.replace(idStr, '{id}');

  return { template };
}

/**
 * Try infinite scroll to trigger more data loading.
 */
async function tryInfiniteScroll(page, jsonResponses) {
  console.log('[spaNetworkMiner] Trying infinite scroll...');

  const newResponses = [];
  const scrollHandler = async (response) => {
    try {
      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('json')) return;
      const status = response.status();
      if (status < 200 || status >= 400) return;

      const text = await response.text().catch(() => null);
      if (!text || text.length < 50) return;

      let body;
      try { body = JSON.parse(text); } catch { return; }

      newResponses.push({ url: response.url(), method: response.request().method(), body, size: text.length });
    } catch { /* ignore */ }
  };

  page.on('response', scrollHandler);

  // Scroll down a few times
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await sleep(1500);
  }

  page.off('response', scrollHandler);

  if (newResponses.length === 0) return null;

  // Check new responses for exhibitor data
  let bestList = null;
  let bestScore = 0;
  let bestFieldMap = null;

  for (const resp of [...jsonResponses, ...newResponses]) {
    const arrays = extractArrays(resp.body);
    for (const { path, array } of arrays) {
      if (array.length < 3) continue;
      const score = scoreExhibitorArray(array);
      if (score > bestScore) {
        bestScore = score;
        bestList = { url: resp.url, method: resp.method, path, array };
        bestFieldMap = buildFieldMap(array[0]);
      }
    }
  }

  if (bestScore >= 30) {
    console.log(`[spaNetworkMiner] Infinite scroll found data: ${bestList.array.length} items (score: ${bestScore})`);
    return { bestList, bestScore, bestFieldMap };
  }

  return null;
}

// ─── Export ─────────────────────────────────────────────────────────

module.exports = { runSpaNetworkMiner };
