/**
 * LIFFY – LEGACY EXPO WORKER (EMAIL OPTIONAL)
 *
 * Key rule:
 * - Email is OPTIONAL
 * - Exhibitor presence = valid result
 * - Pagination & crawl NEVER stop because of missing email
 */

const db = require("./db");
const { chromium } = require("playwright");

const POLL_INTERVAL_MS = 5000;
const MAX_LIST_PAGES = 10;
const MAX_DETAIL_PAGES = 300;
const SCROLL_ROUNDS = 12;
const SCROLL_DELAY_MS = 800;
const PAGE_DELAY_MS = 1200;

let shuttingDown = false;

/* ======================
   WORKER LOOP
====================== */

async function startWorker() {
  console.log("🚀 Liffy Worker started (Email-Optional Mode)");

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  while (!shuttingDown) {
    try {
      await processNextJob();
    } catch (err) {
      console.error("Worker error:", err.message);
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

    const stats = await runLegacyMiner(job);
    await markCompleted(job.id, stats);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Job failed:", err.message);
  } finally {
    client.release();
  }
}

/* ======================
   LEGACY MINER
====================== */

async function runLegacyMiner(job) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });

  const page = await context.newPage();

  const detailLinks = new Set();
  let visited = 0;
  let emailCount = 0;

  try {
    /* -------- LISTING PAGES -------- */
    for (let pageNum = 1; pageNum <= MAX_LIST_PAGES; pageNum++) {
      const listUrl = `${job.input}?page=${pageNum}`;
      console.log(`📄 Listing page ${pageNum}: ${listUrl}`);

      await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      for (let i = 0; i < SCROLL_ROUNDS; i++) {
        await page.mouse.wheel(0, 2000);
        await page.waitForTimeout(SCROLL_DELAY_MS);
      }

      const links = await extractDetailLinks(page);
      if (links.length === 0) {
        console.log("⚠️ No links on this page, stopping pagination");
        break;
      }

      links.forEach(l => detailLinks.add(l));
      await page.waitForTimeout(PAGE_DELAY_MS);
    }

    console.log(`🔗 Total detail pages: ${detailLinks.size}`);

    /* -------- DETAIL PAGES -------- */
    for (const link of detailLinks) {
      if (visited >= MAX_DETAIL_PAGES) break;
      visited++;

      try {
        console.log(`[${visited}/${detailLinks.size}] ${link}`);

        await page.goto(link, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(PAGE_DELAY_MS);

        const html = await page.content();
        const emails = extractEmails(html);
        emailCount += emails.length;

        // SAVE RESULT EVEN IF emails = []
        await saveResult(job, link, emails);

      } catch (err) {
        console.log(`⚠️ Failed detail page: ${err.message}`);
      }
    }

  } finally {
    await browser.close();
  }

  return {
    results: visited,
    emails: emailCount
  };
}

/* ======================
   HELPERS
====================== */

async function extractDetailLinks(page) {
  const links = await page.$$eval(
    'a[href*="/Exhibitor/"], a[href*="ExbDetails"]',
    els => els.map(e => e.href)
  );
  return Array.from(new Set(links));
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
    [
      job.id,
      job.organizer_id,
      source,
      emails || []
    ]
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

  console.log(`✅ Job completed`);
  console.log(`   Exhibitors visited: ${stats.results}`);
  console.log(`   Emails found: ${stats.emails}`);
}

function shutdown() {
  console.log("🛑 Worker shutting down");
  shuttingDown = true;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

startWorker().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
