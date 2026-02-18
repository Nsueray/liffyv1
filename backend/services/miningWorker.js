const { chromium } = require("playwright");
const db = require("../db");

// Shadow Mode Integration (Phase 1 - Step C)
const { normalizeMinerOutput } = require('./normalizer');
const aggregationTrigger = require('./aggregationTrigger');

// ENV (for standalone execution)
const JOB_ID = process.env.MINING_JOB_ID || null;

// Global website blacklist
const WEBSITE_BLACKLIST_HOSTS = [
  "shorturl.at", "bit.ly", "tinyurl.com", "t.co", "goo.gl",
  "is.gd", "ow.ly", "buff.ly", "rebrand.ly", "short.link",
  "cutt.ly", "tiny.cc", "bitly.com", "shorte.st",
  "ufi.org"
];

/* =========================================
   HELPER FUNCTIONS
   ========================================= */

function isBlacklistedWebsite(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return WEBSITE_BLACKLIST_HOSTS.some(blocked =>
      host === blocked || host.endsWith("." + blocked)
    );
  } catch (e) {
    return false;
  }
}

function extractEmails(html) {
  const regex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const matches = html.match(regex) || [];
  const normalized = matches
    .map(e => e.trim().replace(/[,;:.]+$/, ""))
    .filter(Boolean);
  return Array.from(new Set(normalized));
}

function guessWebsiteFromEmail(emails) {
  const genericProviders = [
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com",
    "aol.com", "icloud.com", "mail.com", "yandex.com", "protonmail.com"
  ];
  if (!emails || emails.length === 0) return null;
  for (const email of emails) {
    const parts = email.split("@");
    if (parts.length !== 2) continue;
    const domain = parts[1].toLowerCase();
    const isGeneric = genericProviders.some(p => domain === p || domain.endsWith("." + p));
    if (!isGeneric) return `https://${domain}`;
  }
  return null;
}

/**
 * Check if the page is blocked (Cloudflare, 403, etc.)
 */
async function checkBlock(page, response) {
  // 1. HTTP Status
  if (response && [401, 403, 406, 429].includes(response.status())) {
    console.log(`🚨 BLOCK: HTTP Status ${response.status()}`);
    return true;
  }

  // 2. Page Content Heuristics
  const stats = await page.evaluate(() => {
    const text = (document.body?.innerText || "").toLowerCase();
    const title = (document.title || "").toLowerCase();
    return {
      text,
      title,
      cloudflare: text.includes("cloudflare") || document.querySelector(".cf-error-details") !== null,
      anchors: document.querySelectorAll("a").length
    };
  });

  if (stats.cloudflare) {
    console.log("🚨 BLOCK: Cloudflare detected");
    return true;
  }

  const blockKeywords = ["forbidden", "access denied", "security check", "verify you are human", "captcha"];
  if (blockKeywords.some(kw => stats.text.includes(kw) || stats.title.includes(kw))) {
    console.log("🚨 BLOCK: Suspicious text detected");
    return true;
  }

  // If extremely low anchor count on a list page, it's likely a soft block or empty render
  if (stats.anchors < 3) {
    console.log(`🚨 BLOCK: Very low anchor count (${stats.anchors})`);
    return true;
  }

  return false;
}

/**
 * Smart Auto-Discovery of Detail Links
 */
function extractExhibitorLinks(html, baseUrl, config = {}) {
  const links = [];
  const hrefRegex = /href="([^"]+)"/gi;
  let match;
  
  const explicitPattern = config.detail_url_pattern || null;
  const candidates = [];

  while ((match = hrefRegex.exec(html)) !== null) {
    let url = match[1];
    url = url.replace(/&amp;/g, "&");
    try {
      if (url.startsWith("/")) {
        const base = new URL(baseUrl);
        url = `${base.protocol}//${base.host}${url}`;
      }
      if (url.startsWith("http")) candidates.push(url);
    } catch (e) {}
  }

  for (const url of candidates) {
    if (explicitPattern && url.includes(explicitPattern)) {
      links.push(url);
      continue;
    }
    if (!explicitPattern) {
      try {
        const baseObj = new URL(baseUrl);
        const urlObj = new URL(url);
        if (urlObj.hostname !== baseObj.hostname) continue;
        if (url.includes("/page/") || url.includes("?page=") || url.includes("#")) continue;
        
        // Heuristic: URL is longer and looks like a child
        if (url.match(/exhibitor|profile|company|detail/i)) {
           if (url !== baseUrl && url.length > baseUrl.length) links.push(url);
        } else if (url.startsWith(baseUrl) && url.length > baseUrl.length + 3) {
          links.push(url);
        }
      } catch(e) {}
    }
  }
  return Array.from(new Set(links));
}

/**
 * Smart Label-Based Meta Extraction
 */
async function extractExhibitorMeta(page, exUrl, exHtml, exEmails) {
  const pageTitle = await page.title().catch(() => null);
  let companyName = null;
  
  // Basic company name guess
  try {
    companyName = await page.$eval("h1", el => el.textContent.trim()).catch(() => null);
  } catch (e) {}

  let extra = {};
  try {
    extra = await page.evaluate(() => {
      const res = { website: null, contactName: null, jobTitle: null, phone: null, country: null };
      
      // Label based extractor
      function getByLabel(labels) {
        for (const label of labels) {
          const xpath = `//*[text()[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${label}')]]`;
          const iterator = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
          let node = iterator.iterateNext();
          while (node) {
            let val = null;
            let next = node.nextElementSibling;
            if (next && next.textContent.trim()) val = next.textContent.trim();
            if (!val) {
              const parts = node.textContent.trim().split(/[:|-]/);
              if (parts.length > 1) val = parts.slice(1).join(" ").trim();
            }
            if (!val && node.parentElement) {
              const pNext = node.parentElement.nextElementSibling;
              if (pNext && pNext.textContent.trim()) val = pNext.textContent.trim();
            }
            if (val && val.length > 1 && val.length < 100 && !val.toLowerCase().includes(label)) return val;
            node = iterator.iterateNext();
          }
        }
        return null;
      }

      res.country = getByLabel(["country", "location", "region"]);
      res.contactName = getByLabel(["contact person", "contact name", "representative", "contact:"]);
      res.jobTitle = getByLabel(["job title", "designation", "role"]);
      res.phone = getByLabel(["phone", "mobile", "tel:", "cell"]);

      // Website
      const anchors = Array.from(document.querySelectorAll("a"));
      for (const a of anchors) {
        const href = a.getAttribute("href") || "";
        const text = (a.textContent || "").toLowerCase();
        if (href.startsWith("http") && !href.includes("facebook") && !href.includes("linkedin") && !href.includes("twitter")) {
          if (a.target === "_blank" || text.includes("website") || text.includes("www")) {
            res.website = href;
            break;
          }
        }
      }
      return res;
    });
  } catch(e) {}

  let website = extra.website;
  // Website Fallback
  if (!website) {
    const matches = exHtml.match(/(https?:\/\/(?:www\.)?[A-Z0-9][A-Z0-9\-]{0,61}[A-Z0-9]\.(?:[A-Z0-9\-]{0,61}\.)*[A-Z]{2,})/gi) || [];
    for (const u of matches) {
      if (!isBlacklistedWebsite(u) && !u.includes("exhibitor")) { website = u; break; }
    }
  }
  if (!website && exEmails.length > 0) website = guessWebsiteFromEmail(exEmails);

  return {
    url: exUrl,
    pageTitle,
    companyName,
    contactName: extra.contactName,
    jobTitle: extra.jobTitle,
    phone: extra.phone,
    country: extra.country,
    website,
    emails: exEmails || []
  };
}

/**
 * Smart Pagination to get all Links
 */
async function getAllExhibitorLinks(page, baseUrl, config = {}) {
  const allLinks = [];
  const seenHashes = new Set();
  const maxPages = config.max_pages || 10;
  const delayMs = config.list_page_delay_ms || 2000;

  console.log(`📄 Pagination: max ${maxPages} pages`);

  // Initial Load
  const response = await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  if (await checkBlock(page, response)) throw new Error("BLOCK_DETECTED");

  // Try to detect pages
  let totalPages = maxPages;
  const detected = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll("a"));
    let max = 1;
    for (const l of links) {
      const n = parseInt(l.textContent);
      if (!isNaN(n) && n < 100) max = Math.max(max, n);
    }
    return max;
  });
  if (detected > 1) totalPages = Math.min(detected, maxPages);

  console.log(`📖 Will crawl up to ${totalPages} pages`);

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    if (pageNum > 1) {
      // Smart URL construction — replace existing page param if present
      let paramUrl;
      if (baseUrl.includes("/page/")) {
        paramUrl = baseUrl.replace(/\/page\/\d+/, `/page/${pageNum}`);
      } else if (baseUrl.match(/[?&]page=\d+/)) {
        paramUrl = baseUrl.replace(/([?&])page=\d+/, `$1page=${pageNum}`);
      } else if (baseUrl.endsWith("/")) {
        paramUrl = `${baseUrl}page/${pageNum}/`;
      } else {
        paramUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}page=${pageNum}`;
      }

      console.log(`  🔄 Page ${pageNum}: ${paramUrl}`);
      try {
        const r = await page.goto(paramUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
        if (await checkBlock(page, r)) throw new Error("BLOCK_DETECTED");
      } catch (e) {
        if (e.message.includes("BLOCK_DETECTED")) throw e;
        console.log("    Using fallback query param pagination...");
        // Fallback: also handle existing page param
        let altUrl;
        if (baseUrl.match(/[?&]page=\d+/)) {
          altUrl = baseUrl.replace(/([?&])page=\d+/, `$1page=${pageNum}`);
        } else {
          altUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}page=${pageNum}`;
        }
        await page.goto(altUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      }
    }

    // Scroll to trigger lazy load
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);

    const links = extractExhibitorLinks(await page.content(), page.url(), config);
    if (links.length > 0) {
      const hash = links.slice(0, 5).sort().join("|");
      if (!seenHashes.has(hash)) {
        seenHashes.add(hash);
        allLinks.push(...links);
        console.log(`  ✅ Page ${pageNum}: ${links.length} links`);
      } else {
        console.log(`  ⚠️ Page ${pageNum}: Duplicate content`);
      }
    }
    await page.waitForTimeout(delayMs);
  }

  return Array.from(new Set(allLinks));
}

/* =========================================
   SHADOW MODE HELPER (Phase 1 - Step C)
   ========================================= */

/**
 * Shadow Mode Normalization
 * Converts allResults[] to normalized candidates and logs them
 * DOES NOT persist anything - LOG ONLY
 * 
 * @param {Object} job - Mining job object
 * @param {Array} allResults - Extracted results array
 */
async function runShadowModeNormalization(job, allResults) {
  if (process.env.DISABLE_SHADOW_MODE === 'true') {
    return;
  }

  try {
    console.log(`[SHADOW_MODE] Starting normalization for job ${job.id}`);

    const minerOutput = {
      status: 'success',
      raw: {
        text: '',
        html: '',
        blocks: allResults.map(r => ({
          email: r.emails && r.emails[0] ? r.emails[0] : null,
          emails: r.emails || [],
          company_name: r.companyName || null,
          contact_name: r.contactName || null,
          website: r.website || null,
          country: r.country || null,
          phone: r.phone || null,
          text: null,
          data: r,
        })),
        links: [],
      },
      meta: {
        miner_name: 'miningWorker',
        duration_ms: 0,
        confidence_hint: null,
        source_url: job.input || null,
        page_title: null,
      },
    };

    const normalizationResult = normalizeMinerOutput(minerOutput);

    await aggregationTrigger.process({
      jobId: job.id,
      organizerId: job.organizer_id,
      normalizationResult: normalizationResult,
      metadata: {
        original_result_count: allResults.length,
        source_url: job.input || null,
        strategy: job.strategy || 'playwright',
      },
    });

    console.log(`[SHADOW_MODE] Completed for job ${job.id}: ${normalizationResult.stats.candidates_produced} candidates`);

  } catch (error) {
    console.error(`[SHADOW_MODE] Error for job ${job.id}:`, error.message);
  }
}

/* =========================================
   MAIN STRATEGY
   ========================================= */

async function runPlaywrightStrategy(job) {
  const url = job.input;
  const config = job.config || {};
  console.log(`🌐 [Miner] Starting for: ${url}`);

  const browser = await chromium.launch({ 
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });

  const page = await context.newPage();
  const allResults = [];

  try {
    // 1. Pagination & Link Gathering
    const links = await getAllExhibitorLinks(page, url, config);
    
    if (links.length === 0) {
      console.log("⚠️ No links found. Might be blocked or empty.");
      // Check block one last time on the last visited page
      if (await checkBlock(page, null)) throw new Error("BLOCK_DETECTED");
      return; // Just empty
    }

    console.log(`\n🔎 Visiting ${links.length} detail pages...`);

    // 2. Detail Extraction
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      console.log(`\n➡️ [${i + 1}/${links.length}] ${link}`);
      
      try {
        const r = await page.goto(link, { waitUntil: "domcontentloaded", timeout: 30000 });
        
        // Critical: Check block on detail page too
        if (await checkBlock(page, r)) throw new Error("BLOCK_DETECTED");

        const html = await page.content();
        const emails = extractEmails(html);
        const meta = await extractExhibitorMeta(page, link, html, emails);

        if (meta.companyName) console.log(`  ✅ ${meta.companyName}`);
        if (emails.length) console.log(`  📧 ${emails.join(", ")}`);

        allResults.push(meta);
        
        if (i < links.length - 1) await page.waitForTimeout(config.detail_delay_ms || 1000);

      } catch (err) {
        if (err.message.includes("BLOCK_DETECTED")) throw err; // Re-throw block
        console.log(`  ❌ Error: ${err.message}`);
      }
    }

    // 3. Shadow Mode Normalization (Phase 1 - Step C)
    await runShadowModeNormalization(job, allResults);

    // 4. Save to DB
    const summary = {
        total_exhibitors: links.length,
        total_results: allResults.length,
        total_emails: allResults.reduce((acc, r) => acc + (r.emails?.length||0), 0),
        time_minutes: 0 // Calc higher up if needed
    };
    await saveResultsToDb(job, allResults, summary);

  } finally {
    await browser.close();
  }
}

async function saveResultsToDb(job, results, summary) {
  if (!job.id || !job.organizer_id) return;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let totalEmails = 0;
    for (const r of results) {
      const emails = Array.isArray(r.emails) ? r.emails : [];
      totalEmails += emails.length;
      await client.query(`
        INSERT INTO public.mining_results 
        (job_id, organizer_id, source_url, company_name, contact_name, job_title, phone, country, website, emails, raw)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [job.id, job.organizer_id, r.url, r.companyName, r.contactName, r.jobTitle, r.phone, r.country, r.website, emails, JSON.stringify(r)]);
    }
    
    // Update Job Stats
    await client.query(`
      UPDATE public.mining_jobs 
      SET total_found = COALESCE(total_found, 0) + $1,
          total_emails_raw = COALESCE(total_emails_raw, 0) + $2,
          stats = COALESCE(stats, '{}'::jsonb) || $3::jsonb,
          status = 'completed',
          completed_at = NOW()
      WHERE id = $4
    `, [results.length, totalEmails, JSON.stringify(summary), job.id]);

    await client.query('COMMIT');
    console.log(`💾 Saved ${results.length} results to DB.`);
  } catch(e) {
    await client.query('ROLLBACK');
    console.error("DB Save Error:", e);
  } finally {
    client.release();
  }
}

/**
 * Public Entry Point
 * Can be called by worker.js or standalone
 */
async function runMiningTest(jobOrId) {
  let job;
  
  // If called with just ID (env var style) or object
  if (typeof jobOrId === 'string' || !jobOrId) {
     const jId = jobOrId || JOB_ID;
     if (!jId) { console.log("No Job ID"); return; }
     const client = await db.connect();
     try {
       const res = await client.query('SELECT * FROM mining_jobs WHERE id = $1', [jId]);
       if (res.rows.length) job = res.rows[0];
     } finally { client.release(); }
  } else {
    job = jobOrId;
  }

  if (!job) { console.log("Job not found"); return; }

  // Execute
  try {
    await runPlaywrightStrategy(job);
  } catch (err) {
    if (err.message.includes("BLOCK_DETECTED")) {
        console.log("🚫 BLOCK DETECTED in Service - Re-throwing for Worker to handle.");
        throw err; // Worker.js catches this to trigger manual
    }
    console.error("Mining Fatal Error:", err);
    // If generic error, mark failed
    const client = await db.connect();
    await client.query("UPDATE mining_jobs SET status='failed', error=$1 WHERE id=$2", [err.message, job.id]);
    client.release();
  }
}

module.exports = { runMiningTest };

// Standalone execution support
if (require.main === module) {
  runMiningTest().catch(console.error);
}
