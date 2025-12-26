/**
 * LIFFY – CONTROLLED WATERFALL MINER (FINAL)
 *
 * Strategy order (STOP when success):
 * L1 - DOM-based Expo Directory Crawl (PRIMARY, proven)
 * L2 - XHR / JSON interception (ACCELERATOR)
 * L3 - <script type="application/json"> parsing
 * L4 - Aggressive single-page text scan (LAST RESORT)
 *
 * Deterministic, limited, production-safe.
 */

const db = require("./db");
const { chromium } = require("playwright");
const { URL } = require("url");

const POLL_INTERVAL_MS = 5000;

// Hard limits (Render-safe)
const MAX_LIST_PAGES = 15;
const MAX_DETAIL_PAGES = 300;
const SCROLL_ROUNDS = 12;
const SCROLL_DELAY_MS = 800;
const PAGE_DELAY_MS = 1200;

let shuttingDown = false;

/* ======================
   WORKER LOOP
====================== */

async function startWorker() {
  console.log("🚀 Liffy Mining Worker started (Controlled Waterfall)");

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

    const stats = await runControlledMiner(job);
    await markCompleted(job.id, stats);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Job failed:", err.message);
  } finally {
    client.release();
  }
}

/* ======================
   CONTROLLED WATERFALL
====================== */

async function runControlledMiner(job) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });

  const page = await context.newPage();

  let results = 0;
  let emailCount = 0;

  try {
    /* ---------- L1: DOM DIRECTORY CRAWL (PRIMARY) ---------- */
    console.log("🔹 L1: DOM directory crawl");
    const domResult = await domDirectoryCrawl(page, job);
    if (domResult.results > 0) {
      console.log("✅ L1 succeeded, stopping waterfall");
      return domResult;
    }

    /* ---------- L2: XHR / JSON (ACCELERATOR) ---------- */
    console.log("🔹 L2: XHR interception");
    const xhrResult = await xhrScan(page, job);
    if (xhrResult.results > 0) {
      console.log("✅ L2 succeeded, stopping waterfall");
      return xhrResult;
    }

    /* ---------- L3: SCRIPT JSON ---------- */
    console.log("🔹 L3: script[type=json] parsing");
    const scriptResult = await scriptJsonScan(page, job);
    if (scriptResult.results > 0) {
      console.log("✅ L3 succeeded, stopping waterfall");
      return scriptResult;
    }

    /* ---------- L4: AGGRESSIVE TEXT (LAST) ---------- */
    console.log("🔹 L4: aggressive text scan");
    const textResult = await aggressiveTextScan(page, job);
    return textResult;

  } finally {
    await browser.close();
  }
}

/* ======================
   L1 – DOM DIRECTORY CRAWL
====================== */

async function domDirectoryCrawl(page, job) {
  const detailLinks = new Set();
  let emails = 0;
  let visited = 0;

  for (let p = 1; p <= MAX_LIST_PAGES; p++) {
    const pageUrl = `${job.input}?page=${p}`;
    console.log(`📄 Listing page ${p}: ${pageUrl}`);

    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    for (let i = 0; i < SCROLL_ROUNDS; i++) {
      await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(SCROLL_DELAY_MS);
    }

    const links = await extractDetailLinks(page, job.input);
    if (links.length === 0) break;
    links.forEach(l => detailLinks.add(l));

    await page.waitForTimeout(PAGE_DELAY_MS);
  }

  console.log(`🔗 Collected ${detailLinks.size} detail links`);

  for (const link of detailLinks) {
    if (visited >= MAX_DETAIL_PAGES) break;
    visited++;

    try {
      await page.goto(link, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(PAGE_DELAY_MS);

      const html = await page.content();
      const found = extractEmails(html);

      if (found.length > 0) {
        await saveResult(job, link, found);
        emails += found.length;
      }

    } catch {}
  }

  return { results: visited, emails };
}

/* ======================
   L2 – XHR JSON
====================== */

async function xhrScan(page, job) {
  const collected = new Set();

  page.removeAllListeners("response");
  page.on("response", async (response) => {
    try {
      const ct = response.headers()["content-type"] || "";
      if (!ct.includes("application/json")) return;

      const data = await response.json().catch(() => null);
      if (!data) return;

      const emails = extractEmails(JSON.stringify(data));
      emails.forEach(e => collected.add(e));
    } catch {}
  });

  await page.goto(job.input, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(3000);

  if (collected.size > 0) {
    await saveResult(job, job.input, Array.from(collected));
  }

  return { results: collected.size, emails: collected.size };
}

/* ======================
   L3 – SCRIPT JSON
====================== */

async function scriptJsonScan(page, job) {
  await page.goto(job.input, { waitUntil: "domcontentloaded", timeout: 60000 });

  const jsonBlocks = await page.$$eval(
    'script[type="application/json"]',
    els => els.map(e => e.textContent)
  );

  let emails = [];

  for (const txt of jsonBlocks) {
    try {
      const data = JSON.parse(txt);
      emails.push(...extractEmails(JSON.stringify(data)));
    } catch {}
  }

  if (emails.length > 0) {
    await saveResult(job, job.input, Array.from(new Set(emails)));
  }

  return { results: emails.length, emails: emails.length };
}

/* ======================
   L4 – AGGRESSIVE TEXT
====================== */

async function aggressiveTextScan(page, job) {
  await page.goto(job.input, { waitUntil: "domcontentloaded", timeout: 60000 });
  const text = await page.evaluate(() => document.body.innerText || "");
  const emails = extractEmails(text);

  if (emails.length > 0) {
    await saveResult(job, job.input, emails);
  }

  return { results: emails.length, emails: emails.length };
}

/* ======================
   HELPERS
====================== */

async function extractDetailLinks(page, baseUrl) {
  const base = new URL(baseUrl);
  const domain = base.hostname;

  const hrefs = await page.$$eval("a[href]", els =>
    els.map(a => a.getAttribute("href")).filter(Boolean)
  );

  return Array.from(new Set(
    hrefs
      .filter(h => h.includes("/Exhibitor/ExbDetails/"))
      .map(h => {
        try { return new URL(h, base).href; } catch { return null; }
      })
      .filter(Boolean)
  ));
}

function extractEmails(text) {
  const regex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  return Array.from(new Set(
    (text.match(regex) || []).filter(e =>
      !e.includes(".png") &&
      !e.includes(".jpg") &&
      !e.includes("@2x")
    )
  ));
}

async function saveResult(job, source, emails) {
  await db.query(
    `INSERT INTO mining_results
     (job_id, organizer_id, source_url, emails)
     VALUES ($1, $2, $3, $4)`,
    [job.id, job.organizer_id, source, emails]
  );
}

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

function shutdown() {
  console.log("🛑 Worker shutting down");
  shuttingDown = true;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

startWorker().catch(err => {
  console.error("Fatal worker error:", err);
  process.exit(1);
});
