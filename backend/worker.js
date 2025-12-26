/**
 * Liffy FINAL Hybrid Auto Mining Worker
 *
 * Core principles:
 * - User selects NOTHING
 * - XHR interception is PRIMARY source
 * - Pagination + Scroll are used to trigger XHR calls
 * - DOM parsing is secondary fallback
 * - Deterministic, limited, production-safe
 */

const db = require("./db");
const { chromium } = require("playwright");

const POLL_INTERVAL_MS = 5000;
const MAX_LIST_PAGES = 10;
const SCROLL_ROUNDS = 8;
const SCROLL_DELAY_MS = 1000;
const PAGE_DELAY_MS = 2000;
const MAX_RESULTS = 500;

let shuttingDown = false;

/* ======================
   WORKER LOOP
====================== */

async function startWorker() {
  console.log("🚀 Liffy Mining Worker started (FINAL Hybrid)");

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

    const stats = await runHybridMiner(job);
    await markCompleted(job.id, stats);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Job failed:", err.message);
  } finally {
    client.release();
  }
}

/* ======================
   HYBRID MINER
====================== */

async function runHybridMiner(job) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ]
  });

  const page = await browser.newPage();
  const collected = new Map();

  /* ---- XHR INTERCEPTOR ---- */
  page.on("response", async (response) => {
    try {
      const ct = response.headers()["content-type"] || "";
      if (!ct.includes("application/json")) return;

      const data = await response.json().catch(() => null);
      if (!data) return;

      extractFromJSON(data, collected);
    } catch {}
  });

  try {
    console.log(`🌐 Navigating to ${job.input}`);
    await page.goto(job.input, { waitUntil: "networkidle", timeout: 60000 });

    for (let pageIndex = 1; pageIndex <= MAX_LIST_PAGES; pageIndex++) {
      console.log(`📄 Triggering page ${pageIndex}`);

      // Scroll to trigger lazy-loaded XHRs
      for (let i = 0; i < SCROLL_ROUNDS; i++) {
        await page.mouse.wheel(0, 2000);
        await page.waitForTimeout(SCROLL_DELAY_MS);
      }

      // Try "Next" pagination if exists
      const hasNext = await clickNextIfExists(page);
      if (!hasNext) break;

      await page.waitForTimeout(PAGE_DELAY_MS);
    }

  } finally {
    await browser.close();
  }

  let saved = 0;
  let emails = 0;

  for (const item of collected.values()) {
    if (saved >= MAX_RESULTS) break;

    await db.query(
      `INSERT INTO mining_results
       (job_id, organizer_id, source_url, emails)
       VALUES ($1, $2, $3, $4)`,
      [
        job.id,
        job.organizer_id,
        item.source || job.input,
        item.emails || []
      ]
    );

    saved++;
    emails += item.emails.length;
  }

  return { results: saved, emails };
}

/* ======================
   HELPERS
====================== */

function extractFromJSON(data, collected) {
  if (Array.isArray(data)) {
    data.forEach(d => extractFromJSON(d, collected));
    return;
  }

  if (typeof data !== "object" || !data) return;

  const emails = [];
  for (const val of Object.values(data)) {
    if (typeof val === "string" && val.includes("@")) {
      const found = val.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
      if (found) emails.push(...found);
    }
  }

  if (emails.length > 0) {
    const key = data.id || data.companyId || JSON.stringify(data).slice(0, 50);
    if (!collected.has(key)) {
      collected.set(key, {
        emails: Array.from(new Set(emails)),
        source: data.website || data.url || null
      });
    }
  }

  Object.values(data).forEach(v => extractFromJSON(v, collected));
}

async function clickNextIfExists(page) {
  try {
    const nextButton = await page.$(
      'a:has-text("Next"), button:has-text("Next"), a:has-text(">"), a.next'
    );
    if (!nextButton) return false;

    await nextButton.click();
    return true;
  } catch {
    return false;
  }
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
