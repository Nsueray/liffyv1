/**
 * LIFFY – DEBUG EXPO WORKER
 * Purpose: Observe DOM behavior on Big5 Nigeria
 * Email optional, full crawl logging enabled
 */

const db = require("./db");
const { chromium } = require("playwright");

const POLL_INTERVAL_MS = 5000;
const MAX_LIST_PAGES = 5;     // Debug için düşük
const SCROLL_ROUNDS = 8;
const SCROLL_DELAY_MS = 800;
const PAGE_DELAY_MS = 1500;

let shuttingDown = false;

/* ======================
   WORKER LOOP
====================== */

async function startWorker() {
  console.log("🧪 Liffy DEBUG Worker started");

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  while (!shuttingDown) {
    try {
      await processNextJob();
    } catch (err) {
      console.error("❌ Worker loop error:", err);
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
    console.log("\n==============================");
    console.log(`⛏️ DEBUG JOB START: ${job.id}`);
    console.log(`🌐 INPUT URL: ${job.input}`);
    console.log("==============================");

    await client.query(
      `UPDATE mining_jobs
       SET status='running', started_at=NOW(), error=NULL
       WHERE id=$1`,
      [job.id]
    );
    await client.query("COMMIT");

    await runDebugMiner(job);

    await markCompleted(job.id);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Job failed:", err);
  } finally {
    client.release();
  }
}

/* ======================
   DEBUG MINER
====================== */

async function runDebugMiner(job) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const page = await browser.newPage();

  try {
    for (let pageNum = 1; pageNum <= MAX_LIST_PAGES; pageNum++) {
      const listUrl = `${job.input}?page=${pageNum}`;
      console.log(`\n📄 OPEN LIST PAGE ${pageNum}`);
      console.log(`➡️ ${listUrl}`);

      await page.goto(listUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });

      await page.waitForTimeout(2000);

      /* ---- DOM SNAPSHOT BEFORE SCROLL ---- */
      const initialStats = await page.evaluate(() => {
        return {
          anchors: document.querySelectorAll("a").length,
          hrefAnchors: document.querySelectorAll("a[href]").length,
          bodyTextSample: document.body.innerText.slice(0, 300)
        };
      });

      console.log("🔎 BEFORE SCROLL:");
      console.log("   <a> count:", initialStats.anchors);
      console.log("   <a href> count:", initialStats.hrefAnchors);
      console.log("   body sample:", JSON.stringify(initialStats.bodyTextSample));

      /* ---- SCROLL ---- */
      for (let i = 0; i < SCROLL_ROUNDS; i++) {
        await page.mouse.wheel(0, 2000);
        await page.waitForTimeout(SCROLL_DELAY_MS);
      }

      /* ---- DOM SNAPSHOT AFTER SCROLL ---- */
      const afterScrollStats = await page.evaluate(() => {
        const hrefs = Array.from(document.querySelectorAll("a[href]"))
          .map(a => a.getAttribute("href"))
          .slice(0, 20);

        return {
          anchors: document.querySelectorAll("a").length,
          hrefAnchors: document.querySelectorAll("a[href]").length,
          sampleHrefs: hrefs
        };
      });

      console.log("🔎 AFTER SCROLL:");
      console.log("   <a> count:", afterScrollStats.anchors);
      console.log("   <a href> count:", afterScrollStats.hrefAnchors);
      console.log("   sample hrefs:", afterScrollStats.sampleHrefs);

      /* ---- EXHIBITOR-LIKE LINKS ---- */
      const exhibitorLinks = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("a[href]"))
          .map(a => a.getAttribute("href"))
          .filter(h =>
            h &&
            (h.includes("Exhibitor") ||
             h.includes("exhibitor") ||
             h.includes("company") ||
             h.includes("profile"))
          );
      });

      console.log("🔗 Exhibitor-like hrefs found:", exhibitorLinks.length);
      console.log("   sample:", exhibitorLinks.slice(0, 10));

      if (exhibitorLinks.length === 0) {
        console.log("⚠️ NO exhibitor-like links on this page");
      }

      await page.waitForTimeout(PAGE_DELAY_MS);
    }

  } finally {
    await browser.close();
  }
}

/* ======================
   FINALIZE
====================== */

async function markCompleted(jobId) {
  await db.query(
    `UPDATE mining_jobs
     SET status='completed',
         completed_at=NOW()
     WHERE id=$1`,
    [jobId]
  );

  console.log("✅ DEBUG JOB COMPLETED");
}

function shutdown() {
  console.log("🛑 Worker shutting down");
  shuttingDown = true;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

startWorker().catch(err => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
