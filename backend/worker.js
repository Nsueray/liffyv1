const db = require("./db");
const { sendEmail } = require("./mailer");
// Yeni servisi dahil ediyoruz
const { runMiningTest } = require("./services/miningWorker");

const POLL_INTERVAL_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;

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
  console.log("🧪 Liffy Worker started (INTEGRATED SMART MINER)");

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

    // 1. Pending işi al
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
    console.log(`⛏️ JOB PICKED: ${job.id}`);
    console.log(`🌐 TARGET: ${job.input}`);
    console.log("==============================");

    // 2. Running olarak işaretle
    await client.query(
      `UPDATE mining_jobs
       SET status='running', started_at=NOW(), error=NULL
       WHERE id=$1`,
      [job.id]
    );

    await client.query("COMMIT");

    // 3. SERVİSİ ÇAĞIR (Asıl İş Burada)
    // runMiningTest artık hem kontrol ediyor hem de topluyor.
    await runMiningTest(job);

    console.log("✅ Worker: Job execution finished normally.");

  } catch (err) {
    await client.query("ROLLBACK");

    // 4. BLOK YAKALAMA (Manual Assist)
    if (err.message && err.message.includes("BLOCK_DETECTED")) {
      console.log("🚫 BLOCK DETECTED (via Service) – Triggering Manual Assist...");
      await handleManualAssist(err.jobId || res?.rows[0]?.id);
    } else {
      console.error("❌ Worker Job Failed:", err.message);
    }
  } finally {
    client.release();
  }
}

// Blok durumunda çalışacak Manual Assist fonksiyonu
async function handleManualAssist(jobId) {
  if (!jobId) return;
  
  // Job verisini çek (Input lazım)
  const jobRes = await db.query("SELECT * FROM mining_jobs WHERE id = $1", [jobId]);
  if (jobRes.rows.length === 0) return;
  const job = jobRes.rows[0];

  // Manual required olarak işaretle
  const updateRes = await db.query(
    `UPDATE mining_jobs
     SET manual_required = true,
         manual_reason = 'blocked_source',
         manual_started_at = NOW()
     WHERE id = $1 AND manual_started_at IS NULL
     RETURNING id`,
    [jobId]
  );

  // Email gönder (Sadece ilk seferde)
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
        console.log("📧 Manual mining email sent.");
      } catch (emailErr) {
        console.error("❌ Failed to send email:", emailErr);
      }
    }
  }
  
  console.log("🟡 Job left in RUNNING state for manual assist");
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

startWorker().catch(err => console.error("💥 Fatal error:", err));
