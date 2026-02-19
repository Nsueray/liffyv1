const db = require("./db");
const { sendEmail } = require("./mailer");
const { processMiningJob } = require("./services/miningService");
const { runScheduler } = require("./services/campaignScheduler");

// ============================================================
// UNSUBSCRIBE HELPER IMPORT
// ============================================================
const {
  getUnsubscribeUrl,
  getListUnsubscribeHeaders,
  processEmailCompliance,
  validatePhysicalAddress
} = require("./utils/unsubscribeHelper");

// ============================================================
// TEMPLATE PROCESSOR (shared — single source of truth)
// ============================================================
const { processTemplate, convertPlainTextToHtml } = require("./utils/templateProcessor");


/* =========================================================
   HARD SITE (MANUAL-FIRST) PROTECTION
   ========================================================= */
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
  if (!url) return false;
  try {
    const u = new URL(url.toLowerCase());
    return HARD_SITE_HOSTS.some(h => u.hostname.includes(h));
  } catch {
    return false;
  }
}

/* =========================================================
   SUPERMINER INTEGRATION (UNCHANGED)
   ========================================================= */
let superMiner = null;
let superMinerInitialized = false;

async function initSuperMiner() {
  try {
    superMiner = require("./services/superMiner");

    if (!superMiner.SUPERMINER_ENABLED) {
      console.log("[Worker] SuperMiner DISABLED");
      return false;
    }

    const result = await superMiner.initializeSuperMiner(db);
    if (result.success) {
      superMinerInitialized = true;
      console.log("[Worker] SuperMiner initialized");
      return true;
    }
  } catch (e) {
    console.error("[Worker] SuperMiner init error:", e.message);
  }
  return false;
}

function shouldUseSuperMiner(job) {
  if (isHardSite(job.input)) {
    console.log("[Worker] 🔒 HARD SITE → legacy + manual only");
    return false;
  }
  if (!superMiner || !superMiner.SUPERMINER_ENABLED || !superMinerInitialized) {
    return false;
  }
  if (job.type !== "url") return false;
  if (job.config?.use_superminer === false) return false;
  return true;
}

/* =========================================================
   CONSTANTS
   ========================================================= */
const POLL_INTERVAL_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;
const CAMPAIGN_SCHEDULER_INTERVAL_MS = 10000;
const CAMPAIGN_SENDER_INTERVAL_MS = 3000;
const VERIFICATION_PROCESSOR_INTERVAL_MS = 15000;
const EMAIL_BATCH_SIZE = 5;

/* =========================================================
   HEARTBEAT
   ========================================================= */
setInterval(() => {
  console.log("💓 Worker heartbeat – alive");
}, HEARTBEAT_INTERVAL_MS);

/* =========================================================
   CAMPAIGN SCHEDULER (ORIGINAL – RESTORED)
   ========================================================= */
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

/* =========================================================
   CAMPAIGN EMAIL SENDER (UPDATED - with Unsubscribe Support)
   ========================================================= */
async function processSendingCampaigns() {
  const client = await db.connect();
  try {
    // JOIN sender_identities (s) and organizers (o) for sender info + API key + physical address
    const res = await client.query(`
      SELECT 
        c.*, 
        t.subject, 
        t.body_html, 
        t.body_text,
        s.from_email as sender_email,
        s.from_name as sender_name,
        s.reply_to as sender_reply_to,
        o.sendgrid_api_key,
        o.physical_address
      FROM campaigns c
      JOIN email_templates t ON c.template_id = t.id
      LEFT JOIN sender_identities s ON c.sender_id = s.id
      LEFT JOIN organizers o ON c.organizer_id = o.id
      WHERE c.status = 'sending'
      LIMIT 5
    `);

    for (const campaign of res.rows) {
      // ============================================================
      // PHYSICAL ADDRESS VALIDATION (BLOCKER)
      // ============================================================
      const addressValidation = validatePhysicalAddress({ 
        physical_address: campaign.physical_address 
      });
      
      if (!addressValidation.valid) {
        console.error(`🚫 Campaign ${campaign.id} BLOCKED: ${addressValidation.error}`);
        await client.query(`
          UPDATE campaigns 
          SET status = 'failed', 
              error = $2,
              completed_at = NOW()
          WHERE id = $1
        `, [campaign.id, addressValidation.error]);
        continue; // Skip this campaign
      }

      const recipients = await client.query(`
        SELECT * FROM campaign_recipients
        WHERE campaign_id = $1 AND status='pending'
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      `, [campaign.id, EMAIL_BATCH_SIZE]);

      console.log(`[Campaign ${campaign.id}] Processing ${recipients.rows.length} recipients`);

      for (const r of recipients.rows) {
        try {
          // ============================================================
          // GENERATE UNSUBSCRIBE URL
          // ============================================================
          const unsubscribeUrl = getUnsubscribeUrl(r.email, campaign.organizer_id);
          
          // ============================================================
          // PROCESS TEMPLATE WITH UNSUBSCRIBE URL
          // ============================================================
          const processedSubject = processTemplate(campaign.subject, r);
          let processedHtml = processTemplate(campaign.body_html, r, { unsubscribe_url: unsubscribeUrl });
          processedHtml = convertPlainTextToHtml(processedHtml);

          // Process HTML with compliance (unsubscribe + footer + address)
          const complianceResult = processEmailCompliance({
            html: processedHtml,
            text: processTemplate(campaign.body_text || "", r, { unsubscribe_url: unsubscribeUrl }),
            recipientEmail: r.email,
            organizerId: campaign.organizer_id,
            physicalAddress: campaign.physical_address,
            lang: 'en'
          });
          
          // ============================================================
          // GENERATE LIST-UNSUBSCRIBE HEADERS
          // ============================================================
          const listUnsubHeaders = getListUnsubscribeHeaders(
            r.email, 
            campaign.organizer_id, 
            campaign.sender_email
          );

          await sendEmail({
            to: r.email,
            subject: processedSubject,
            html: complianceResult.html,
            text: complianceResult.text,
            fromEmail: campaign.sender_email,
            fromName: campaign.sender_name,
            replyTo: campaign.sender_reply_to,
            sendgridApiKey: campaign.sendgrid_api_key,
            // NEW: Pass List-Unsubscribe headers
            headers: listUnsubHeaders
          });
          
          await client.query(
            `UPDATE campaign_recipients SET status='sent', sent_at=NOW() WHERE id=$1`,
            [r.id]
          );
          console.log(`✅ Email sent to ${r.email} (with unsubscribe)`);
        } catch (e) {
          await client.query(
            `UPDATE campaign_recipients SET status='failed', last_error=$2 WHERE id=$1`,
            [r.id, e.message]
          );
          console.error(`❌ Email failed for ${r.email}: ${e.message}`);
        }
      }

      // Check if campaign is complete
      const remaining = await client.query(`
        SELECT COUNT(*) as count FROM campaign_recipients 
        WHERE campaign_id = $1 AND status = 'pending'
      `, [campaign.id]);

      if (parseInt(remaining.rows[0].count) === 0) {
        await client.query(`
          UPDATE campaigns SET status = 'completed', completed_at = NOW() 
          WHERE id = $1
        `, [campaign.id]);
        console.log(`🎉 Campaign ${campaign.id} completed!`);
      }
    }
  } finally {
    client.release();
  }
}

async function startCampaignSender() {
  while (true) {
    try {
      await processSendingCampaigns();
    } catch (err) {
      console.error("❌ Campaign sender error:", err.message);
    }
    await sleep(CAMPAIGN_SENDER_INTERVAL_MS);
  }
}

/* =========================================================
   VERIFICATION PROCESSOR (ZeroBounce queue)
   ========================================================= */
async function startVerificationProcessor() {
  const { processQueue } = require("./services/verificationService");
  console.log("[Verification] Verification worker started — polling every " + (VERIFICATION_PROCESSOR_INTERVAL_MS / 1000) + "s");

  while (true) {
    try {
      // Staleness recovery: reset items stuck in 'processing' that never completed back to 'pending'
      // Safe because processing is synchronous within each worker cycle — any unfinished items are from a prior crash
      const staleRes = await db.query(`
        UPDATE verification_queue
        SET status = 'pending'
        WHERE status = 'processing'
          AND processed_at IS NULL
        RETURNING id
      `);
      if (staleRes.rowCount > 0) {
        console.log(`[Verification] Reset ${staleRes.rowCount} stale processing items back to pending`);
      }

      // Find organizers with a ZeroBounce key and pending queue items
      const orgRes = await db.query(`
        SELECT DISTINCT o.id
        FROM organizers o
        JOIN verification_queue vq ON vq.organizer_id = o.id AND vq.status = 'pending'
        WHERE o.zerobounce_api_key IS NOT NULL
        LIMIT 10
      `);

      for (const org of orgRes.rows) {
        try {
          const result = await processQueue(org.id, 100);
          console.log(`[Verification] Batch processed: ${result.processed} verified, ${result.results.length} total for organizer ${org.id}`);
        } catch (orgErr) {
          console.error(`[Verification] Error for organizer ${org.id}:`, orgErr.message, orgErr.stack);
        }
      }
    } catch (err) {
      console.error("[Verification] Processor error:", err.message, err.stack);
    }
    await sleep(VERIFICATION_PROCESSOR_INTERVAL_MS);
  }
}

/* =========================================================
   WORKER LOOP
   ========================================================= */
async function startWorker() {
  console.log("🧪 Liffy Worker (STABLE + UNSUBSCRIBE COMPLIANT)");

  await initSuperMiner();
  startCampaignScheduler();
  startCampaignSender();
  startVerificationProcessor().catch(err => {
    console.error("[Verification] FATAL: Verification processor crashed:", err.message, err.stack);
  });

  while (true) {
    await processNextJob();
    await sleep(POLL_INTERVAL_MS);
  }
}

async function processNextJob() {
  const client = await db.connect();
  let job;

  try {
    await client.query("BEGIN");
    const res = await client.query(`
      SELECT * FROM mining_jobs
      WHERE status='pending'
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    if (!res.rows.length) {
      await client.query("COMMIT");
      return;
    }
    job = res.rows[0];

    await client.query(
      `UPDATE mining_jobs SET status='running', started_at=NOW() WHERE id=$1`,
      [job.id]
    );
    await client.query("COMMIT");

    try {
      let legacyResult = null;

if (shouldUseSuperMiner(job)) {
  await superMiner.runMiningJob(job, db);
} else {
  legacyResult = await processMiningJob(job);

  // 🔴 CRITICAL: HARD SITE + ZERO RESULT = BLOCK
  if (
    isHardSite(job.input) &&
    (
      legacyResult?.contacts?.length === 0 ||
      legacyResult?.total_found === 0 ||
      legacyResult?.total_emails_raw === 0
    )
  ) {
    console.log("🚫 HARD SITE returned 0 results – treating as BLOCK, triggering MANUAL");
    await triggerManualAssist(job);
    return;
  }
}
    } catch (e) {
      if (e.message.includes("BLOCK")) {
        await triggerManualAssist(job);
      } else {
        throw e;
      }
    }

  } catch (err) {
    await client.query("ROLLBACK");
    if (job) {
      await db.query(
        `UPDATE mining_jobs SET status='failed', error=$2 WHERE id=$1`,
        [job.id, err.message]
      );
    }
  } finally {
    client.release();
  }
}

/* =========================================================
   MANUAL ASSIST (ORIGINAL BEHAVIOR)
   ========================================================= */
async function triggerManualAssist(job) {
  await db.query(
    `UPDATE mining_jobs
     SET manual_required=true, manual_reason='blocked_source'
     WHERE id=$1`,
    [job.id]
  );

  const token = process.env.MANUAL_MINER_TOKEN;
  if (!token) return;

  const cmd = `
node mine.js \\
  --job-id ${job.id} \\
  --api https://api.liffy.app/api \\
  --token ${token} \\
  --input "${job.input}"
`;

  await sendEmail({
    to: "suer@elan-expo.com",
    subject: `Manual Mining Required for Job ${job.id}`,
    text: cmd
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
startWorker();
