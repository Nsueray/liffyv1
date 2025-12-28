const db = require("./db");
const { chromium } = require("playwright");
const { sendEmail } = require("./mailer");

const POLL_INTERVAL_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;

const MAX_LIST_PAGES = 5;
const SCROLL_ROUNDS = 8;
const SCROLL_DELAY_MS = 800;
const PAGE_DELAY_MS = 1500;

/* ======================
   HEARTBEAT (IDLE SAFE)
====================== */

setInterval(() => {
  console.log("💓 Worker heartbeat – alive");
}, HEARTBEAT_INTERVAL_MS);

/* ======================
   SIGNAL HANDLING
====================== */

process.on("SIGTERM", () => {
  console.log("⚠️ SIGTERM received – ignored");
});

process.on("SIGINT", () => {
  console.log("⚠️ SIGINT received – ignored");
});

/* ======================
   WORKER LOOP
====================== */

async function startWorker() {
  console.log("🧪 Liffy DEBUG Worker started (BLOCK DETECTION FINAL – IDLE SAFE)");

  while (true) {
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
      console.log("🚫 BLOCK DETECTED – manual assist required");

      const updateRes = await db.query(
        `UPDATE mining_jobs
         SET manual_required = true,
             manual_reason = 'blocked_source',
             manual_started_at = NOW()
         WHERE id = $1 AND manual_started_at IS NULL
         RETURNING id`,
        [job.id]
      );

      if (updateRes.rows.length > 0) {
        const token = process.env.MANUAL_MINER_TOKEN;

        if (!token) {
          console.error("❌ MANUAL_MINER_TOKEN is NOT set. Email skipped.");
        } else {
          const command = [
            "node mine.js \\",
            `  --job-id ${job.id} \\`,
            "  --api https://api.liffy.app/api \\",
            `  --token ${token}`
          ].join("\n");

          try {
            await sendEmail({
              to: "suer@elan-expo.com",
              subject: `Manual Mining Required for Job ${job.id}`,
              text: command
            });
            console.log("📧 Manual mining email sent.");
          } catch (err) {
            console.error("❌ Failed to send manual mining email:", err);
          }
        }
      } else {
        console.log("📧 Email already sent earlier, skipping.");
      }

      console.log("🟡 Job left RUNNING for manual assist");
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
   DEBUG MINER
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
      const url =
        pageNum === 1
          ? job.input
          : `${job.input}${job.input.includes("?") ? "&" : "?"}page=${pageNum}`;

      console.log(`📄 OPEN LIST PAGE ${pageNum}: ${url}`);

      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });

      if (response && [401, 403].includes(response.status())) {
        blockSignals.http403 = true;
      }

      await page.waitForTimeout(2000);

      const stats = await page.evaluate(() => {
        const text = document.body?.innerText || "";
        return {
          text,
          cloudflare:
            text.toLowerCase().includes("cloudflare") ||
            document.querySelector(".cf-error-details") !== null,
          anchors: document.querySelectorAll("a").length
        };
      });

      if (stats.text.toLowerCase().includes("forbidden")) {
        blockSignals.forbiddenText = true;
      }
      if (stats.cloudflare) blockSignals.cloudflare = true;
      if (stats.anchors === 0) {
        blockSignals.zeroAnchorsBefore = true;
        blockSignals.zeroAnchorsAfter = true;
      }

      if (Object.values(blockSignals).filter(Boolean).length >= 2) {
        return true;
      }

      await page.waitForTimeout(PAGE_DELAY_MS);
    }
  } finally {
    await browser.close();
  }

  return false;
}

/* ======================
   FINALIZE
====================== */

async function markCompleted(jobId) {
  await db.query(
    `UPDATE mining_jobs
     SET status='completed', completed_at=NOW()
     WHERE id=$1`,
    [jobId]
  );
  console.log("✅ Job completed");
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

startWorker().catch(err => console.error("💥 Fatal error:", err));
