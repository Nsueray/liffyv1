/**
 * LIFFY VIS Exhibitor Miner v1.0
 *
 * Extracts exhibitor data from Messe Düsseldorf VIS platform sites.
 * VIS powers: Valve World Expo, wire, Tube, interpack, MEDICA, etc.
 *
 * Strategy:
 *   Phase 1 — Directory (A-Z): fetch /vis-api/.../directory/{a-z} for all letters
 *   Phase 2 — Profile: fetch /vis-api/.../exhibitors/{exh}/slices/profile for each
 *   Phase 3 — Merge list + profile → raw contact array
 *
 * API requires x-vis-domain header on every request (value = site origin).
 * Browser is used only to establish session cookies; all data fetched via fetch().
 *
 * Usage (module only — browser lifecycle managed by flowOrchestrator wrapper):
 *   const { runVisExhibitorMiner } = require("./visExhibitorMiner");
 *   const cards = await runVisExhibitorMiner(page, url, config);
 */

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

/**
 * Derive the VIS API base path from the input URL.
 * Input:  https://www.valveworldexpo.com/vis/v1/en/directory/a
 * Output: { origin: "https://www.valveworldexpo.com", basePath: "/vis-api/vis/v1/en" }
 */
function deriveApiBase(inputUrl) {
  const parsed = new URL(inputUrl);
  const origin = parsed.origin;

  // Extract vis path: /vis/v1/{lang}/...
  const visMatch = parsed.pathname.match(/\/(vis\/v\d+\/[a-z]{2})\b/);
  if (visMatch) {
    return { origin, basePath: `/vis-api/${visMatch[1]}` };
  }

  // Fallback: try to find /vis-api/ in the URL itself
  const apiMatch = parsed.pathname.match(/(\/vis-api\/vis\/v\d+\/[a-z]{2})\b/);
  if (apiMatch) {
    return { origin, basePath: apiMatch[1] };
  }

  // Default fallback
  return { origin, basePath: '/vis-api/vis/v1/en' };
}

/**
 * Main mining function.
 * @param {import('playwright').Page} page - Playwright Page object
 * @param {string} url - Target URL
 * @param {Object} config - Job config
 * @returns {Promise<Array>} Raw card array
 */
async function runVisExhibitorMiner(page, url, config = {}) {
  const delayMs = config.delay_ms || 500;
  const maxDetails = config.max_details || 500;
  const totalTimeout = config.total_timeout || 480000; // 8 min
  const startTime = Date.now();

  console.log(`[visExhibitorMiner] Starting: ${url}`);

  const { origin, basePath } = deriveApiBase(url);
  const visDomain = origin;
  console.log(`[visExhibitorMiner] API base: ${origin}${basePath}, x-vis-domain: ${visDomain}`);

  // Navigate to the page to establish session cookies
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
  } catch (err) {
    console.warn(`[visExhibitorMiner] Navigation warning: ${err.message}`);
  }

  // ========================================
  // PHASE 1: Directory A-Z
  // ========================================
  console.log('[visExhibitorMiner] Phase 1: Fetching directory A-Z...');

  const allExhibitors = [];

  for (const letter of LETTERS) {
    if (Date.now() - startTime > totalTimeout) {
      console.log('[visExhibitorMiner] Timeout reached during directory fetch');
      break;
    }

    const dirUrl = `${origin}${basePath}/directory/${letter}`;

    try {
      const items = await page.evaluate(async (params) => {
        const resp = await fetch(params.url, {
          headers: {
            'Accept': 'application/json',
            'x-vis-domain': params.visDomain,
          },
          credentials: 'include',
        });
        if (!resp.ok) return [];
        return resp.json();
      }, { url: dirUrl, visDomain });

      if (Array.isArray(items) && items.length > 0) {
        for (const item of items) {
          allExhibitors.push({
            exh: item.exh || null,
            name: item.name || null,
            country: item.country || null,
            city: item.city || null,
            location: item.location || null,
          });
        }
      }
    } catch (err) {
      console.warn(`[visExhibitorMiner] Directory /${letter} error: ${err.message}`);
    }
  }

  console.log(`[visExhibitorMiner] Phase 1 complete: ${allExhibitors.length} exhibitors from A-Z`);

  if (allExhibitors.length === 0) {
    console.log('[visExhibitorMiner] No exhibitors found, returning empty');
    return [];
  }

  // ========================================
  // PHASE 2: Profile fetch
  // ========================================
  console.log('[visExhibitorMiner] Phase 2: Fetching profiles...');

  const profileMap = new Map(); // exh → profile data
  const toFetch = allExhibitors.filter(e => e.exh).slice(0, maxDetails);
  const concurrency = 5;
  const chunkSize = concurrency;
  let emailsFound = 0;

  for (let i = 0; i < toFetch.length; i += chunkSize) {
    if (Date.now() - startTime > totalTimeout) {
      console.log('[visExhibitorMiner] Timeout reached during profile fetch');
      break;
    }

    const chunk = toFetch.slice(i, i + chunkSize);

    try {
      const results = await page.evaluate(async (params) => {
        const output = {};
        const fetches = params.items.map(async (item) => {
          const profileUrl = `${params.apiBase}/exhibitors/${item.exh}/slices/profile`;
          try {
            const resp = await fetch(profileUrl, {
              headers: {
                'Accept': 'application/json',
                'x-vis-domain': params.visDomain,
              },
              credentials: 'include',
            });
            if (resp.ok) {
              output[item.exh] = await resp.json();
            }
          } catch { /* skip */ }
        });
        await Promise.all(fetches);
        return output;
      }, {
        items: chunk,
        apiBase: `${origin}${basePath}`,
        visDomain,
      });

      for (const [exh, profile] of Object.entries(results)) {
        profileMap.set(exh, profile);
        if (profile.email) emailsFound++;
      }
    } catch (err) {
      console.warn(`[visExhibitorMiner] Profile batch error at ${i}: ${err.message}`);
    }

    // Delay between chunks (not after last)
    if (i + chunkSize < toFetch.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }

    // Progress logging every 50
    const progress = Math.min(i + chunkSize, toFetch.length);
    if (progress % 50 === 0 || progress === toFetch.length) {
      console.log(`[visExhibitorMiner] Profile progress: ${progress}/${toFetch.length} (${emailsFound} emails)`);
    }
  }

  console.log(`[visExhibitorMiner] Phase 2 complete: ${profileMap.size} profiles, ${emailsFound} emails`);

  // ========================================
  // PHASE 3: Merge + output
  // ========================================
  console.log('[visExhibitorMiner] Phase 3: Merging list + profile data...');

  const contacts = [];

  for (const exh of allExhibitors) {
    const profile = exh.exh ? profileMap.get(exh.exh) : null;

    const card = {
      company_name: (profile && profile.name) || exh.name || null,
      email: (profile && profile.email) || null,
      phone: (profile && profile.phone && profile.phone.phone) || null,
      website: extractWebsite(profile),
      country: extractCountry(profile, exh),
      city: extractCity(profile, exh),
      address: extractAddress(profile),
      contact_name: null,
      job_title: null,
      source_url: url,
    };

    contacts.push(card);
  }

  const withEmail = contacts.filter(c => c.email).length;
  console.log(`[visExhibitorMiner] Final: ${contacts.length} contacts, ${withEmail} with email`);

  return contacts;
}

// ── Field extraction helpers ──

function extractWebsite(profile) {
  if (!profile || !Array.isArray(profile.links) || profile.links.length === 0) return null;
  const link = profile.links.find(l => l.link && l.link.startsWith('http'));
  return link ? link.link : null;
}

function extractCountry(profile, listItem) {
  if (profile && profile.profileAddress && profile.profileAddress.country) {
    return profile.profileAddress.country;
  }
  return listItem.country || null;
}

function extractCity(profile, listItem) {
  if (profile && profile.profileAddress && profile.profileAddress.city) {
    return profile.profileAddress.city;
  }
  return listItem.city || null;
}

function extractAddress(profile) {
  if (!profile || !profile.profileAddress) return null;
  const addr = profile.profileAddress;
  const parts = [];
  if (Array.isArray(addr.address) && addr.address.length > 0) {
    parts.push(addr.address.join(', '));
  }
  if (addr.zip) parts.push(addr.zip);
  if (addr.city) parts.push(addr.city);
  return parts.length > 0 ? parts.join(', ') : null;
}

module.exports = { runVisExhibitorMiner };
