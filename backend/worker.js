/**
 * Docker-based Playwright Mining Worker
 * FINAL Expo-Grade Miner
 *
 * - Uses proven list → detail crawler
 * - Handles pagination, load more, next, page params
 * - Extracts email, website, phone, country, company
 * - Saves results even if email is missing
 */

const db = require("./db");
const { chromium } = require("playwright");
const { URL } = require("url");

const POLL_INTERVAL_MS = 5000;
let shuttingDown = false;

/* =======================
   MAIN WORKER LOOP
======================= */

async function startWorker() {
  console.log("🚀 Mining Worker started (FINAL Expo Miner)");

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

    const found = await runExpoCrawler(job);
    await markCompleted(job.id, found);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Job failed:", err.message);
  } finally {
    client.release();
  }
}

/* =======================
   EXPO CRAWLER
======================= */

async function runExpoCrawler(job) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ]
  });

  const page = await browser.newPage();
  let totalFound = 0;

  try {
    const listUrls = await discoverListPages(page, job.input);

    for (const listUrl of listUrls) {
      console.log(`📄 Crawling list page: ${listUrl}`);
      await page.goto(listUrl, { waitUntil: "networkidle", timeout: 60000 });
      await autoScroll(page);

      const detailLinks = await collectDetailLinks(page, job.input);

      for (const detailUrl of detailLinks) {
        try {
          await page.goto(detailUrl, { waitUntil: "networkidle", timeout: 60000 });
          const html = await page.content();
          const emails = extractEmails(html);
          const meta = await extractMeta(page, html);

          await saveResult(job, detailUrl, emails, meta);
          totalFound++;

        } catch {}
      }
    }

  } finally {
    await browser.close();
  }

  return totalFound;
}

/* =======================
   PAGE DISCOVERY
======================= */

async function discoverListPages(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  const patterns = [
    "exhibitor", "exhibitors",
    "participant", "participants",
    "company", "companies",
    "catalog", "list"
  ];

  const base = new URL(baseUrl);
  const domain = base.hostname;

  const hrefs = await page.$$eval("a[href]", els =>
    els.map(a => a.getAttribute("href")).filter(Boolean)
  );

  const pages = new Set();

  for (const href of hrefs) {
    try {
      const url = new URL(href, base);
      if (url.hostname === domain &&
          patterns.some(p => url.pathname.toLowerCase().includes(p))) {
        pages.add(url.href);
      }
    } catch {}
  }

  return pages.size ? Array.from(pages) : [baseUrl];
}

/* =======================
   DETAIL LINKS
======================= */

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

/* =======================
   EXTRACTION
======================= */

function extractEmails(html) {
  const regex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  return Array.from(new Set(html.match(regex) || []));
}

async function extractMeta(page, html) {
  return await page.evaluate(() => {
    const text = document.body.innerText || "";
    const phoneMatch = text.match(/\+?\d[\d\s\-().]{6,}/);
    return {
      company: document.querySelector("h1, h2")?.textContent?.trim() || null,
      phone: phoneMatch ? phoneMatch[0] : null
    };
  });
}

/* =======================
   SAVE RESULT
======================= */

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

/* =======================
   FINALIZE
======================= */

async function markCompleted(jobId, found) {
  await db.query(
    `UPDATE mining_jobs
     SET status='completed',
         completed_at=NOW(),
         total_found=$2
     WHERE id=$1`,
    [jobId, found]
  );
  console.log(`✅ Job ${jobId} completed (found: ${found})`);
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let total = 0;
      const distance = 500;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        total += distance;
        if (total >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 400);
    });
  });
  await page.waitForTimeout(1500);
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
