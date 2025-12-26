/**
 * LIFFY – LEGACY ID-AWARE EXPO WORKER
 *
 * Purpose:
 * - Reproduce the old "170 email" behavior
 * - Extract exhibitor IDs from DOM
 * - Generate detail URLs manually
 * - Crawl detail pages and extract emails
 *
 * This is a PROOF worker, not a universal engine.
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
  console.log("🚀 Liffy Legacy ID-Aware Worker started");

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
   LEGACY MINER (ID-AWARE)
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

  const exhibitorIds = new Set();
  let visited = 0;
  let emailCount = 0;

  try {
    for (let pageNum = 1; pageNum <= MAX_LIST_PAGES; pageNum++) {
      const listUrl = `${job.input}?page=${pageNum}`;
      console.log(`📄 Listing page ${pageNum}: ${listUrl}`);

      await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      // Scroll hard to ensure DOM JS runs
      for (let i = 0; i < SCROLL_ROUNDS; i++) {
        await page.mouse.wheel(0, 2000);
        await page.waitForTimeout(SCROLL_DELAY_MS);
      }

      // 🔑 EXTRACT EXHIBITOR IDS
      const idsOnPage = await page.evaluate(() => {
        const ids = new Set();

        // 1️⃣ onclick handlers
        document.querySelectorAll("[onclick]").forEach(el => {
          const v = el.getAttribute("onclick") || "";
          const match = v.match(/(\d{3,})/);
          if (match) ids.add(match[1]);
        });

        // 2️⃣ data-* attributes
        document.querySelectorAll("[data-exhibitor-id],[data-id]").forEach(el => {
          const v =
            el.getAttribute("data-exhibitor-id") ||
            el.getAttribute("data-id");
          if (v && /^\d+$/.test(v)) ids.add(v);
        });

        // 3️⃣ inline JS references in HTML
        const html = document.documentElement.innerHTML;
        const regex = /ExbDetails\/(\d{3,})/g;
        let m;
        while ((m = regex.exec(html)) !== null) {
          ids.add(m[1]);
        }

        return Array.from(ids);
      });

      if (idsOnPage.length === 0) {
        console.log("⚠️ No IDs found on this page, stopping pagination");
        break;
      }

      idsOnPage.forEach(id => exhibitorIds.add(id));
      await page.waitForTimeout(PAGE_DELAY_MS);
    }

    console.log(`🔑 Total exhibitor IDs collected: ${exhibitorIds.size}`);

    // 🔍 VISIT DETAIL PAGES
    for (const id of exhibitorIds) {
      if (visited >= MAX_DETAIL_PAGES) break;
      visited++;

      const detailUrl = `${job.input.replace("/ExhibitorsList", "")}/Exhibitor/ExbDetails/${id}`;
      console.log(`➡️ [${visited}] ${detailUrl}`);

      try {
        await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(PAGE_DELAY_MS);

        const html = await page.content();
        const emails = extractEmails(html);

        if (emails.length > 0) {
          await saveResult(job, detailUrl, emails);
          emailCount += emails.length;
        }

      } catch {}
    }

  } finally {
    await browser.close();
  }

  return { results: visited, emails: emailCount };
}

/* ======================
   HELPERS
====================== */

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
    `✅ Job ${jobId} completed (pages: ${stats.results}, emails: ${stats.emails})`
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
