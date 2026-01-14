const db = require("./db");
const { sendEmail } = require("./mailer");
const { processMiningJob } = require("./services/miningService");
const { runScheduler } = require("./services/campaignScheduler");

const POLL_INTERVAL_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;
const CAMPAIGN_SCHEDULER_INTERVAL_MS = 10000;

/* ======================
   HEARTBEAT
====================== */
setInterval(() => {
  console.log("💓 Worker heartbeat – alive");
}, HEARTBEAT_INTERVAL_MS);

/* ======================
   SIGNAL HANDLING
====================== */
process.on("SIGTERM", () => console.log("⚠️ SIGTERM received – ignored"));
process.on("SIGINT", () => console.log("⚠️ SIGINT received – ignored"));

/* ======================
   CAMPAIGN SCHEDULER LOOP
====================== */
async function startCampaignScheduler() {
  while (true) {
    try {
      await runScheduler();
    } catch (err) {
      console.error("❌ Campaign scheduler error:", err.message);
    }
    await sleep(CAMPAIGN_SCHEDULER_INTERVAL_MS);
  }
}

/* ======================
   WORKER LOOP
====================== */
async function startWorker() {
  console.log("🧪 Liffy Worker V12.1 (Orchestrator Driven)");

  // Start campaign scheduler in parallel (non-blocking)
  startCampaignScheduler().catch((err) => {
    console.error("❌ Campaign scheduler fatal error:", err.message);
  });

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
  let currentJobId = null;

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
    currentJobId = job.id;

    console.log("\n==============================");
    console.log(`⛏️ JOB PICKED: ${job.id}`);
    console.log(`📂 TYPE: ${job.type}`);
    console.log(`🎯 STRATEGY: ${job.strategy || "auto"}`);
    console.log(`🌐 TARGET: ${job.input}`);
    console.log("==============================");

    await client.query(
      `UPDATE mining_jobs
       SET status = 'running', started_at = NOW(), error = NULL
       WHERE id = $1`,
      [job.id]
    );

    await client.query("COMMIT");

    /* ======================
       ORCHESTRATOR ENTRY
    ====================== */
    let result;

    try {
      result = await processMiningJob(job);
    } catch (err) {
      if (
        err.message &&
        (
          err.message.includes("Executable doesn't exist") ||
          err.message.includes("playwright install") ||
          err.message.includes("browserType.launch")
        )
      ) {
        console.log("🚫 PLAYWRIGHT NOT AVAILABLE – Triggering Manual Assist...");
        await handleManualAssist(job.id);
        return;
      }
      throw err;
    }

    /* ======================
       POST-RESULT BLOCK CHECK
    ====================== */
    if (
      result?.status === "FAILED" &&
      Array.isArray(result.logs) &&
      result.logs.some(l => l.includes("BLOCKED"))
    ) {
      console.log("🚫 BLOCKED result detected – Triggering Manual Assist...");
      await handleManualAssist(job.id);
    }

    console.log("✅ Worker: Job execution finished normally.");

  } catch (err) {
    await client.query("ROLLBACK");

    if (err.message && err.message.includes("BLOCK_DETECTED")) {
      console.log("🚫 BLOCK DETECTED – Triggering Manual Assist...");
      if (currentJobId) {
        await handleManualAssist(currentJobId);
      }
    } else {
      console.error("❌ Worker Job Failed:", err.message);
      if (currentJobId) {
        try {
          await db.query(
            "UPDATE mining_jobs SET status = 'failed', error = $1 WHERE id = $2",
            [err.message, currentJobId]
          );
        } catch (e) {
          /* ignore */
        }
      }
    }
  } finally {
    client.release();
  }
}

/* ======================
   MANUAL ASSIST
====================== */
async function handleManualAssist(jobId) {
  if (!jobId) return;

  const jobRes = await db.query(
    "SELECT * FROM mining_jobs WHERE id = $1",
    [jobId]
  );
  if (jobRes.rows.length === 0) return;

  const job = jobRes.rows[0];

  console.log(`📧 Preparing manual assist email for job ${jobId}...`);

  const updateRes = await db.query(
    `UPDATE mining_jobs
     SET manual_required = true,
         manual_reason = 'blocked_source',
         manual_started_at = NOW()
     WHERE id = $1 AND manual_started_at IS NULL
     RETURNING id`,
    [jobId]
  );

  if (updateRes.rows.length > 0) {
    const token = process.env.MANUAL_MINER_TOKEN;
    if (token) {
      const command = [
        "node mine.js \\",
        `  --job-id ${job.id} \\`,
        "  --api https://api.liffy.app/api \\",
        `  --token ${token} \\`,
        `  --input "${job.input}"`
      ].join("\n");

      try {
        await sendEmail({
          to: "suer@elan-expo.com",
          subject: `Manual Mining Required for Job ${job.id}`,
          text: command
        });
        console.log("📧 Manual mining email SENT successfully.");
      } catch (emailErr) {
        console.error("❌ Failed to send email:", emailErr);
      }
    }
  } else {
    console.log("ℹ️ Manual assist already triggered, skipping email.");
  }

  console.log("🟡 Job left in RUNNING state for manual assist");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

startWorker().catch((err) => console.error("💥 Fatal error:", err));
