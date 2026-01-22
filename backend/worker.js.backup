const db = require("./db");
const { sendEmail } = require("./mailer");
const { processMiningJob } = require("./services/miningService");
const { runScheduler } = require("./services/campaignScheduler");

const POLL_INTERVAL_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;
const CAMPAIGN_SCHEDULER_INTERVAL_MS = 10000;
const CAMPAIGN_SENDER_INTERVAL_MS = 3000; // Email sending check every 3 sec
const EMAIL_BATCH_SIZE = 5; // Send 5 emails per batch

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
   CAMPAIGN SCHEDULER LOOP (scheduled → sending)
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
   CAMPAIGN EMAIL SENDER LOOP (NEW!)
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

/**
 * Process all campaigns in 'sending' status
 */
async function processSendingCampaigns() {
  const client = await db.connect();
  
  try {
    // Find campaigns in 'sending' status
    const campaignsRes = await client.query(`
      SELECT c.*, t.subject, t.body_html, t.body_text
      FROM campaigns c
      JOIN email_templates t ON c.template_id = t.id
      WHERE c.status = 'sending'
      LIMIT 5
    `);
    
    if (campaignsRes.rows.length === 0) {
      return; // No sending campaigns
    }
    
    for (const campaign of campaignsRes.rows) {
      try {
        await processCampaignBatch(client, campaign);
      } catch (err) {
        console.error(`❌ Error processing campaign ${campaign.id}:`, err.message);
      }
    }
    
  } finally {
    client.release();
  }
}

/**
 * Process a batch of emails for one campaign
 */
async function processCampaignBatch(client, campaign) {
  const organizer_id = campaign.organizer_id;
  
  // Get organizer's SendGrid API key
  const orgRes = await client.query(
    `SELECT sendgrid_api_key FROM organizers WHERE id = $1`,
    [organizer_id]
  );
  
  if (!orgRes.rows[0]?.sendgrid_api_key) {
    console.log(`⚠️ Campaign ${campaign.id}: No SendGrid API key, skipping`);
    return;
  }
  const apiKey = orgRes.rows[0].sendgrid_api_key;
  
  // Get sender identity
  const senderRes = await client.query(
    `SELECT * FROM sender_identities WHERE id = $1 AND is_active = true`,
    [campaign.sender_id]
  );
  
  if (senderRes.rows.length === 0) {
    console.log(`⚠️ Campaign ${campaign.id}: No active sender, pausing`);
    await client.query(
      `UPDATE campaigns SET status = 'paused', error = 'Sender not found or inactive' WHERE id = $1`,
      [campaign.id]
    );
    return;
  }
  const sender = senderRes.rows[0];
  
  // Get pending recipients
  const recipientsRes = await client.query(`
    SELECT * FROM campaign_recipients
    WHERE campaign_id = $1 AND status = 'pending'
    ORDER BY id ASC
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  `, [campaign.id, EMAIL_BATCH_SIZE]);
  
  const recipients = recipientsRes.rows;
  
  // If no pending recipients, mark campaign as completed
  if (recipients.length === 0) {
    const pendingCheck = await client.query(
      `SELECT COUNT(*) as count FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending'`,
      [campaign.id]
    );
    
    if (parseInt(pendingCheck.rows[0].count) === 0) {
      await client.query(
        `UPDATE campaigns SET status = 'completed', completed_at = NOW() WHERE id = $1`,
        [campaign.id]
      );
      console.log(`✅ Campaign "${campaign.name}" completed!`);
    }
    return;
  }
  
  console.log(`📤 Sending ${recipients.length} emails for campaign "${campaign.name}"...`);
  
  let sentCount = 0;
  let failCount = 0;
  
  for (const r of recipients) {
    try {
      // Personalize template
      const subject = processTemplate(campaign.subject, r);
      const html = processTemplate(campaign.body_html, r);
      const text = processTemplate(campaign.body_text || "", r);
      
      // Send email
      const result = await sendEmail({
        to: r.email,
        subject: subject,
        text: text,
        html: html,
        from_name: sender.from_name,
        from_email: sender.from_email,
        reply_to: sender.reply_to || null,
        sendgrid_api_key: apiKey
      });
      
      if (result?.success) {
        sentCount++;
        await client.query(
          `UPDATE campaign_recipients SET status = 'sent', sent_at = NOW() WHERE id = $1`,
          [r.id]
        );
        
        // Log success
        await client.query(
          `INSERT INTO email_logs (organizer_id, campaign_id, template_id, recipient_email, status, sent_at)
           VALUES ($1, $2, $3, $4, 'sent', NOW())`,
          [organizer_id, campaign.id, campaign.template_id, r.email]
        );
      } else {
        throw new Error(result?.error || 'Send failed');
      }
      
    } catch (err) {
      failCount++;
      console.error(`  ❌ Failed to send to ${r.email}: ${err.message}`);
      await client.query(
        `UPDATE campaign_recipients SET status = 'failed', last_error = $2 WHERE id = $1`,
        [r.id, err.message]
      );
    }
    
    // Small delay between emails (rate limiting)
    await sleep(500);
  }
  
  console.log(`  📊 Batch result: ${sentCount} sent, ${failCount} failed`);
}

/**
 * Template variable replacement
 */
function processTemplate(text, recipient) {
  if (!text) return "";
  
  const name = recipient.name || "";
  let company = "";
  
  if (recipient.meta) {
    const metaObj = typeof recipient.meta === 'string' 
      ? JSON.parse(recipient.meta) 
      : recipient.meta;
    company = metaObj.company || metaObj.company_name || "";
  }
  
  let processed = text;
  processed = processed.replace(/{{name}}/gi, name);
  processed = processed.replace(/{{first_name}}/gi, name.split(' ')[0] || '');
  processed = processed.replace(/{{company}}/gi, company);
  processed = processed.replace(/{{company_name}}/gi, company);
  processed = processed.replace(/{{email}}/gi, recipient.email || '');
  
  return processed;
}

/* ======================
   WORKER LOOP (Mining Jobs)
====================== */
async function startWorker() {
  console.log("🧪 Liffy Worker V12.2 (With Email Sender)");

  // Start campaign scheduler in parallel
  startCampaignScheduler().catch((err) => {
    console.error("❌ Campaign scheduler fatal error:", err.message);
  });
  
  // Start campaign email sender in parallel (NEW!)
  startCampaignSender().catch((err) => {
    console.error("❌ Campaign sender fatal error:", err.message);
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
