cat > backend/worker.js << 'EOF'
const db = require("./db");
const { sendEmail } = require("./mailer");
const { runMiningTest } = require("./services/miningWorker");
const { runFileMining } = require("./services/fileMiner");
const { runUrlMiningJob } = require("./services/urlMiner");

const POLL_INTERVAL_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;

setInterval(() => {
  console.log("💓 Worker heartbeat – alive");
}, HEARTBEAT_INTERVAL_MS);

process.on("SIGTERM", () => console.log("⚠️ SIGTERM received – ignored"));
process.on("SIGINT", () => console.log("⚠️ SIGINT received – ignored"));

async function startWorker() {
  console.log("🧪 Liffy Worker V11.2 (Smart Routing)");

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
    console.log(`🎯 STRATEGY: ${job.strategy || 'auto'}`);
    console.log(`🌐 TARGET: ${job.input}`);
    console.log("==============================");

    await client.query(
      `UPDATE mining_jobs
       SET status='running', started_at=NOW(), error=NULL
       WHERE id=$1`,
      [job.id]
    );

    await client.query("COMMIT");

    // ============================================
    // 🚀 SMART ROUTING
    // ============================================
    
    if (job.type === 'file' || job.type === 'pdf' || job.type === 'excel' || job.type === 'word' || job.type === 'other') {
      // 📁 FILE MINING
      console.log("   🔀 Route → FILE MINER");
      await runFileMining(job);
      
    } else if (job.type === 'url' && job.strategy === 'playwright') {
      // 🎭 PLAYWRIGHT MINING (JS-heavy sites, anti-bot)
      console.log("   🔀 Route → PLAYWRIGHT MINER");
      await runMiningTest(job);
      
    } else if (job.type === 'url') {
      // ⚡ AXIOS GOLDEN (Default - Fast & Light)
      console.log("   🔀 Route → AXIOS MINER (Golden)");
      await runUrlMiningJob(job.id, job.organizer_id);
      
    } else {
      // 🤔 Unknown type - try Axios as fallback
      console.log(`   🔀 Route → FALLBACK (unknown type: ${job.type})`);
      await runUrlMiningJob(job.id, job.organizer_id);
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
          await db.query("UPDATE mining_jobs SET status='failed', error=$1 WHERE id=$2", [err.message, currentJobId]);
        } catch(e) { /* ignore */ }
      }
    }
  } finally {
    client.release();
  }
}

async function handleManualAssist(jobId) {
  if (!jobId) return;
  
  const jobRes = await db.query("SELECT * FROM mining_jobs WHERE id = $1", [jobId]);
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

startWorker().catch(err => console.error("💥 Fatal error:", err));
EOF
