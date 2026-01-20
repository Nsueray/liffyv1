const db = require("./db");
const { sendEmail } = require("./mailer");
const { processMiningJob } = require("./services/miningService");
const { runScheduler } = require("./services/campaignScheduler");

// ============================================
// CLASS A (HARD SITE) PROTECTION
// ============================================
// Bu siteler ASLA SuperMiner kullanmaz.
// Deterministik legacy miner ZORUNLUDUR.
const HARD_SITE_HOSTS = [
  "big5construct",
  "big5global",
  "thebig5",
  "big5expo",
  "big5constructnigeria",
  "big5constructegypt",
  "big5constructsaudi",
  "big5constructkenya",
  "big5constructethiopia"
];

function isHardSite(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url.toLowerCase());
    return HARD_SITE_HOSTS.some(h => u.hostname.includes(h));
  } catch {
    return false;
  }
}

// ============================================
// SUPERMINER INTEGRATION (v3.1)
// ============================================
let superMiner = null;
let superMinerInitialized = false;

async function initSuperMiner() {
  try {
    superMiner = require("./services/superMiner");

    if (!superMiner.SUPERMINER_ENABLED) {
      console.log("[Worker] SuperMiner DISABLED - using legacy system");
      return false;
    }

    console.log(`[Worker] SuperMiner v${superMiner.VERSION} - Initializing...`);

    const result = await superMiner.initializeSuperMiner(db);

    if (result.success) {
      superMinerInitialized = true;
      console.log(`[Worker] ✅ SuperMiner initialized (mode: ${result.mode})`);
      return true;
    } else {
      console.error("[Worker] ❌ SuperMiner init failed:", result.error);
      return false;
    }
  } catch (err) {
    console.error("[Worker] ❌ SuperMiner load error:", err.message);
    return false;
  }
}

function shouldUseSuperMiner(job) {
  // 1️⃣ Hard site → ASLA SuperMiner
  if (isHardSite(job.input)) {
    console.log("[Worker] 🔒 HARD SITE detected – forcing LEGACY miner");
    return false;
  }

  // 2️⃣ Feature flag & init
  if (!superMiner || !superMiner.SUPERMINER_ENABLED || !superMinerInitialized) {
    return false;
  }

  // 3️⃣ Sadece URL job’ları
  if (job.type !== "url") {
    return false;
  }

  // 4️⃣ Explicit opt-out
  if (job.config?.use_superminer === false) {
    return false;
  }

  // Default: SuperMiner serbest
  return true;
}
// ============================================

const POLL_INTERVAL_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;
const CAMPAIGN_SCHEDULER_INTERVAL_MS = 10000;
const CAMPAIGN_SENDER_INTERVAL_MS = 3000;
const EMAIL_BATCH_SIZE = 5;

/* ======================
   HEARTBEAT
====================== */
setInterval(() => {
  console.log("💓 Worker heartbeat – alive");
}, HEARTBEAT_INTERVAL_MS);

/* ======================
   SIGNAL HANDLING
====================== */
process.on("SIGTERM", async () => {
  console.log("⚠️ SIGTERM received – shutting down gracefully");
  if (superMiner && superMinerInitialized) {
    try {
      await superMiner.shutdown();
      console.log("[Worker] SuperMiner shutdown complete");
    } catch (err) {
      console.error("[Worker] SuperMiner shutdown error:", err.message);
    }
  }
});
process.on("SIGINT", () => console.log("⚠️ SIGINT received – ignored"));

/* ======================
   CAMPAIGN SCHEDULER
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
   CAMPAIGN EMAIL SENDER
====================== */
async function startCampaignSender() {
  console.log("📧 Campaign Email Sender started");
  while (true) {
    try {
      await processSendingCampaigns();
    } catch (err) {
      console.error("❌ Campaign sender error:", err.message);
    }
    await sleep(CAMPAIGN_SENDER_INTERVAL_MS);
  }
}

/* ======================
   WORKER LOOP
====================== */
async function startWorker() {
  console.log("🧪 Liffy Worker V12.4 (Hard-Site Safe)");

  await initSuperMiner();

  startCampaignScheduler().catch(() => {});
  startCampaignSender().catch(() => {});

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
    console.log(`🌐 TARGET: ${job.input}`);
    console.log(`🔧 ENGINE: ${shouldUseSuperMiner(job) ? "SuperMiner" : "Legacy"}`);
    console.log("==============================");

    await client.query(
      `UPDATE mining_jobs
       SET status = 'running', started_at = NOW(), error = NULL
       WHERE id = $1`,
      [job.id]
    );

    await client.query("COMMIT");

    if (shouldUseSuperMiner(job)) {
      await superMiner.runMiningJob(job, db);
    } else {
      await processMiningJob(job);
    }

    console.log("✅ Worker: Job execution finished normally");

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Worker Job Failed:", err.message);

    if (currentJobId) {
      await db.query(
        "UPDATE mining_jobs SET status='failed', error=$1 WHERE id=$2",
        [err.message, currentJobId]
      );
    }
  } finally {
    client.release();
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

startWorker().catch(err => console.error("💥 Fatal error:", err));
