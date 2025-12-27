/**
 * LIFFY – DEBUG EXPO WORKER
 * STEP 1 FINAL: Block Detection + Deep Logging
 * (Claude fixes applied)
 */

const db = require("./db");
const { chromium } = require("playwright");

const POLL_INTERVAL_MS = 5000;
const MAX_LIST_PAGES = 5;
const SCROLL_ROUNDS = 8;
const SCROLL_DELAY_MS = 800;
const PAGE_DELAY_MS = 1500;

let shuttingDown = false;

/* ======================
   WORKER LOOP
====================== */

async function startWorker() {
  console.log("🧪 Liffy DEBUG Worker started (BLOCK DETECTION FINAL)");

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

    const blocked = await runDebugMiner(job);

    if (blocked) {
      console.log("🚫 BLOCK DETECTED – marking job as manual_required");

      await db.query(
        `UPDATE mining_jobs
         SET manual_required = true,
             manual_reason = 'blocked_source',
             manual_started_at = NOW()
         WHERE id = $1`,
        [job.id]
      );

      console.log("🟡 Job left in RUNNING state for manual assist");
      return;
    }

    await markCompleted(job.id);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Job failed:", err);
  } finally {
    client.release();
  }
}

/* ======================
   DEBUG MINER + BLOCK DETECTION
====================== */

async function runDebugMiner(job) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const page = await browser.newPage();

  let blockSignals = {
    http403: false,
    forbiddenText: false,
    zeroAnchorsBefore: false,
    zeroAnchorsAfter: false,
    cloudflare: false
  };

  try {
    for (let pageNum = 1; pageNum <= MAX_LIST_PAGES; pageNum++) {

      const listUrl =
        pageNum === 1
          ? job.input
          : `${job.input}${job.input.includes("?") ? "&" : "?"}page=${pageNum}`;

      console.log(`\n📄 OPEN LIST PAGE ${pageNum}`);
      console.log(`➡️ ${listUrl}`);

      const response = await page.goto(listUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });

      /* ---- HTTP STATUS CHECK ---- */
      if (response) {
        const status = response.status();
        if (status === 403 || status === 401) {
          blockSignals.http403 = true;
          console.log("🚨 HTTP STATUS BLOCK:", status);
        }
      }

      await page.waitForTimeout(2000);

      /* ---- BODY + CLOUDFLARE CHECK ---- */
      const bodyStats = await page.evaluate(() => {
        const text = document.body ? document.body.innerText : "";
        return {
          sample: text.slice(0, 300),
          hasCloudflare:
            text.toLowerCase().includes("cloudflare") ||
            document.querySelector(".cf-error-details") !== null
        };
      });

      console.log("🧾 BODY SAMPLE:", JSON.stringify(bodyStats.sample));

      if (
        bodyStats.sample.includes("403") ||
        bodyStats.sample.toLowerCase().includes("forbidden")
      ) {
        blockSignals.forbiddenText = true;
        console.log("🚨 FORBIDDEN TEXT DETECTED IN BODY");
      }

      if (bodyStats.hasCloudflare) {
        blockSignals.cloudflare = true;
        console.log("🚨 CLOUDFLARE BLOCK PAGE DETECTED");
      }

      /* ---- DOM SNAPSHOT BEFORE SCROLL ---- */
      const beforeScroll = await page.evaluate(() => {
        return document.querySelectorAll("a").length;
      });

      console.log("🔎 BEFORE SCROLL <a> count:", beforeScroll);

      if (beforeScroll === 0) {
        blockSignals.zeroAnchorsBefore = true;
      }

      /* ---- SCROLL ---- */
      for (let i = 0; i < SCROLL_ROUNDS; i++) {
        await page.mouse.wheel(0, 2000);
        await page.waitForTimeout(SCROLL_DELAY_MS);
      }

      /* ---- DOM SNAPSHOT AFTER SCROLL ---- */
      const afterScroll = await page.evaluate(() => {
        return document.querySelectorAll("a").length;
      });

      console.log("🔎 AFTER SCROLL <a> count:", afterScroll);

      if (afterScroll === 0) {
        blockSignals.zeroAnchorsAfter = true;
      }

      /* ---- BLOCK DECISION ---- */
      const signalCount = Object.values(blockSignals).filter(Boolean).length;

      console.log("📊 BLOCK SIGNALS:", blockSignals);
      console.log("📊 SIGNAL COUNT:", signalCount);

      if (signalCount >= 2) {
        console.log("⛔ BLOCK CONFIRMED (>=2 signals)");
        return true;
      }

      await page.waitForTimeout(PAGE_DELAY_MS);
    }

  } finally {
    await browser.close();
  }

  console.log("✅ NO BLOCK DETECTED – site appears crawlable");
  return false;
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

  console.log("✅ DEBUG JOB COMPLETED (NO BLOCK)");
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
