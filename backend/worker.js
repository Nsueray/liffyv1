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

/* =========================================================
   TEMPLATE PROCESSING (Placeholder replacement)
   ========================================================= */
function processTemplate(text, recipient, extras = {}) {
  if (!text) return "";
  
  const fullName = recipient.name || "";
  const nameParts = fullName.trim().split(/\s+/);
  const firstName = nameParts[0] || "";
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "";
  
  let meta = {};
  if (recipient.meta) {
    try {
      meta = typeof recipient.meta === "string" ? JSON.parse(recipient.meta) : recipient.meta;
    } catch (e) {
      meta = {};
    }
  }
  
  const companyName = meta.company || meta.company_name || "";
  const country = meta.country || "";
  const position = meta.position || meta.job_title || meta.title || "";
  const website = meta.website || "";
  const tag = Array.isArray(meta.tags) ? (meta.tags[0] || "") : (meta.tag || "");
  const email = recipient.email || "";
  
  let processed = text;
  processed = processed.replace(/{{first_name}}/gi, firstName);
  processed = processed.replace(/{{last_name}}/gi, lastName);
  processed = processed.replace(/{{name}}/gi, fullName);
  processed = processed.replace(/{{company_name}}/gi, companyName);
  processed = processed.replace(/{{company}}/gi, companyName);
  processed = processed.replace(/{{email}}/gi, email);
  processed = processed.replace(/{{country}}/gi, country);
  processed = processed.replace(/{{position}}/gi, position);
  processed = processed.replace(/{{website}}/gi, website);
  processed = processed.replace(/{{tag}}/gi, tag);
  
  // Unsubscribe URL replacement (from extras)
  if (extras.unsubscribe_url) {
    processed = processed.replace(/{{unsubscribe_url}}/gi, extras.unsubscribe_url);
    processed = processed.replace(/{{unsubscribe_link}}/gi, extras.unsubscribe_url);
  }
  
  return processed;
}


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
const VERIFICATION_PROCESSOR_INTERVAL_MS = 30000;
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
          
          // Process HTML with compliance (unsubscribe + footer + address)
          const complianceResult = processEmailCompliance({
            html: processTemplate(campaign.body_html, r, { unsubscribe_url: unsubscribeUrl }),
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

  while (true) {
    try {
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
          const result = await processQueue(org.id, 50);
          if (result.processed > 0) {
            console.log(`[Verification] Processed ${result.processed} emails for organizer ${org.id}`);
          }
        } catch (orgErr) {
          console.error(`[Verification] Error for organizer ${org.id}:`, orgErr.message);
        }
      }
    } catch (err) {
      console.error("❌ Verification processor error:", err.message);
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
  startVerificationProcessor();

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
