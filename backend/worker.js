/**
 * Liffy Expo-Grade Auto Mining Worker
 *
 * Behaviour:
 * - User selects nothing
 * - System automatically:
 *   1) Loads list pages
 *   2) Handles pagination / load more / next
 *   3) Scrolls for lazy-loaded content
 *   4) Visits exhibitor/detail pages
 *   5) Extracts email OR contact intelligence
 * - Deterministic, limited, production-safe
 */

const db = require("./db");
const { chromium } = require("playwright");
const { URL } = require("url");

const POLL_INTERVAL_MS = 5000;
const MAX_LIST_PAGES = 10;
const MAX_DETAIL_PAGES = 150;
const SCROLL_DELAY_MS = 800;
const PAGE_DELAY_MS = 1500;

let shuttingDown = false;

/* ======================
   WORKER LOOP
====================== */

async function startWorker() {
  console.log("🚀 Liffy Mining Worker started (Expo-Grade)");

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  while (!shuttingDown) {
    try {
      await processNextJob();
    } catch (err) {
      console.error("Worker loop error:", err.message);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function processNextJob() {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const res = await client.query(`
      SELECT *
      FROM mining_jobs
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);

    if (res.rows.length === 0) {
      await client.query("COMMIT");
      return;
    }

    const job = res.rows[0];
    console.log(`⛏️ Processing job ${job.id}`);

    await client.query(
      `UPDATE mining_jobs
       SET status='running', started_at=NOW(), error=NULL
       WHERE id=$1`,
      [job.id]
    );

    await client.query("COMMIT");

    const stats = await runExpoMiner(job);
    await markCompleted(job.id, stats);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Job failed:", err.message);
  } finally {
    client.release();
  }
}

/* ======================
   EXPO MINER
====================== */

async function runExpoMiner(job) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });

  const page = await context.newPage();

  let resultsCount = 0;
  let emailCount = 0;

  try {
    const listPages = await discoverListPages(page, job.input);

    let visitedDetails = 0;

    for (const listUrl of listPages.slice(0, MAX_LIST_PAGES)) {
      console.log(`📄 Crawling list: ${listUrl}`);

      await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await intelligentScroll(page);

      const detailLinks = await collectDetailLinks(page, job.input);

      for (const detailUrl of detailLinks) {
        if (visitedDetails >= MAX_DETAIL_PAGES) break;
        visitedDetails++;

        try {
          await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
          await page.waitForTimeout(PAGE_DELAY_MS);

          const html = await page.content();
          const emails = extractEmails(html);
          const meta = await extractMeta(page, html);

          if (emails.length > 0 || meta.company || meta.website || meta.phone) {
            await saveResult(job, detailUrl, emails, meta);
            resultsCount++;
            emailCount += emails.length;
          }

        } catch {}
      }
    }

  } finally {
    await browser.close();
  }

  return {
    results: resultsCount,
    emails: emailCount
  };
}

/* ======================
   DISCOVERY
====================== */

async function discoverListPages(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  const base = new URL(baseUrl);
  const domain = base.hostname;

  const patterns = [
    "exhibitor", "exhibitors",
    "participant", "participants",
    "company", "companies",
    "brand", "catalog", "list"
  ];

  const hrefs = await page.$$eval("a[href]", els =>
    els.map(a => a.getAttribute("href")).filter(Boolean)
  );

  const pages = new Set();

  for (const href of hrefs) {
    try {
      const url = new URL(href, base);
      if (
        url.hostname === domain &&
        patterns.some(p => url.pathname.toLowerCase().includes(p))
      ) {
        pages.add(url.href);
      }
    } catch {}
  }

  return pages.size ? Array.from(pages) : [baseUrl];
}

async function collectDetailLinks(page, baseUrl) {
  const base = new URL(baseUrl);
  const domain = base.hostname;

  const hrefs = await page.$$eval("a[href]", els =>
    els.map(a => a.getAttribute("href")).filter(Boolean)
  );

  const links = new Set();

  for (const href of hrefs) {
    try {
      const url = new URL(href, base);
      if (url.hostname === domain && url.pathname.length > 10) {
        links.add(url.href);
      }
    } catch {}
  }

  return Array.from(links);
}

/* ======================
   EXTRACTION
====================== */

function extractEmails(html) {
  const regex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  return Array.from(new Set(html.match(regex) || []));
}

async function extractMeta(page, html) {
  return await page.evaluate(() => {
    const text = document.body.innerText || "";
    const phoneMatch = text.match(/\+?\d[\d\s\-().]{6,}/);

    const websiteLink = Array.from(document.querySelectorAll("a[href^='http']"))
      .map(a => a.getAttribute("href"))
      .find(h => h && !h.includes("facebook") && !h.includes("linkedin"));

    return {
      company: document.querySelector("h1, h2")?.textContent?.trim() || null,
      phone: phoneMatch ? phoneMatch[0] : null,
      website: websiteLink || null
    };
  });
}

/* ======================
   SAVE
====================== */

async function saveResult(job, url, emails, meta) {
  await db.query(
    `INSERT INTO mining_results
     (job_id, organizer_id, source_url, emails)
     VALUES ($1, $2, $3, $4)`,
    [
      job.id,
      job.organizer_id,
      url,
      emails.length ? emails : []
    ]
  );
}

/* ======================
   FINALIZE
====================== */

async function markCompleted(jobId, stats) {
  await db.query(
    `UPDATE mining_jobs
     SET status='completed',
         completed_at=NOW(),
         total_found=$2,
         total_emails_raw=$3
     WHERE id=$1`,
    [jobId, stats.results, stats.emails]
  );

  console.log(
    `✅ Job ${jobId} completed (results: ${stats.results}, emails: ${stats.emails})`
  );
}

async function intelligentScroll(page) {
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(SCROLL_DELAY_MS);
  }
}

function shutdown() {
  console.log("🛑 Worker shutting down");
  shuttingDown = true;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

startWorker().catch(err => {
  console.error("Fatal worker error:", err);
  process.exit(1);
});
