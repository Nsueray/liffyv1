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
   SUPERMINER INTEGRATION
   ========================================================= */
let superMiner = null;
let superMinerInitialized = false;

async function initSuperMiner() {
  try {
    superMiner = require("./services/superMiner");

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
    console.log("[Worker] HARD SITE → legacy + manual only");
    return false;
  }
  if (!superMiner || !superMinerInitialized) {
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
const EMAIL_BATCH_SIZE = parseInt(process.env.EMAIL_BATCH_SIZE, 10) || 50;
const EMAIL_CONCURRENCY = parseInt(process.env.EMAIL_CONCURRENCY, 10) || 10;
const EMAIL_CHUNK_PAUSE_MS = 500;
const EMAIL_RETRY_MAX = 3;
const EMAIL_RETRY_BASE_MS = 2000;

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
   SENDGRID 429 RETRY WRAPPER
   ========================================================= */
async function sendWithRetry(emailOpts) {
  for (let attempt = 0; attempt <= EMAIL_RETRY_MAX; attempt++) {
    try {
      await sendEmail(emailOpts);
      return;
    } catch (err) {
      const status = err.code || err.statusCode || (err.response && err.response.statusCode);
      if (status === 429 && attempt < EMAIL_RETRY_MAX) {
        const delayMs = EMAIL_RETRY_BASE_MS * Math.pow(2, attempt); // 2s, 4s, 8s
        console.log(`[EmailSend] 429 rate limit for ${emailOpts.to}, retry ${attempt + 1}/${EMAIL_RETRY_MAX} in ${delayMs / 1000}s`);
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
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

      console.log(`[Campaign ${campaign.id}] Processing ${recipients.rows.length} recipients (concurrency=${EMAIL_CONCURRENCY})`);

      // Process recipients in concurrent chunks
      const chunks = [];
      for (let i = 0; i < recipients.rows.length; i += EMAIL_CONCURRENCY) {
        chunks.push(recipients.rows.slice(i, i + EMAIL_CONCURRENCY));
      }

      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];

        await Promise.all(chunk.map(async (r) => {
          try {
            const unsubscribeUrl = getUnsubscribeUrl(r.email, campaign.organizer_id);
            const processedSubject = processTemplate(campaign.subject, r);
            let processedHtml = processTemplate(campaign.body_html, r, { unsubscribe_url: unsubscribeUrl });
            processedHtml = convertPlainTextToHtml(processedHtml);

            const complianceResult = processEmailCompliance({
              html: processedHtml,
              text: processTemplate(campaign.body_text || "", r, { unsubscribe_url: unsubscribeUrl }),
              recipientEmail: r.email,
              organizerId: campaign.organizer_id,
              physicalAddress: campaign.physical_address,
              lang: 'en'
            });

            const listUnsubHeaders = getListUnsubscribeHeaders(
              r.email,
              campaign.organizer_id,
              campaign.sender_email
            );

            const verpReplyTo = { email: `c-${campaign.id.slice(0,8)}-r-${r.id.slice(0,8)}@reply.liffy.app`, name: campaign.sender_name || 'Reply' };

            // Send with 429 exponential backoff retry
            await sendWithRetry({
              to: r.email,
              subject: processedSubject,
              html: complianceResult.html,
              text: complianceResult.text,
              fromEmail: campaign.sender_email,
              fromName: campaign.sender_name,
              replyTo: verpReplyTo,
              sendgridApiKey: campaign.sendgrid_api_key,
              headers: listUnsubHeaders
            });

            await client.query(
              `UPDATE campaign_recipients SET status='sent', sent_at=NOW() WHERE id=$1`,
              [r.id]
            );

            await recordSentEvent(client, campaign.organizer_id, campaign.id, r);

            console.log(`✅ Email sent to ${r.email}`);
          } catch (e) {
            await client.query(
              `UPDATE campaign_recipients SET status='failed', last_error=$2 WHERE id=$1`,
              [r.id, e.message]
            );
            console.error(`❌ Email failed for ${r.email}: ${e.message}`);
          }
        }));

        // Pause between chunks to avoid burst-triggering rate limits
        if (ci < chunks.length - 1) {
          await sleep(EMAIL_CHUNK_PAUSE_MS);
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

/**
 * Record a 'sent' event to canonical campaign_events table.
 * Best-effort person_id lookup. Never breaks the send flow.
 */
async function recordSentEvent(client, organizerId, campaignId, recipient) {
  try {
    let personId = null;
    const personRes = await client.query(
      `SELECT id FROM persons WHERE organizer_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1`,
      [organizerId, recipient.email]
    );
    if (personRes.rows.length > 0) {
      personId = personRes.rows[0].id;
    }

    await client.query(`
      INSERT INTO campaign_events (
        organizer_id, campaign_id, recipient_id, person_id,
        event_type, email, occurred_at
      ) VALUES ($1, $2, $3, $4, 'sent', $5, NOW())
    `, [organizerId, campaignId, recipient.id, personId, recipient.email]);
  } catch (err) {
    // Never break the send flow
    console.error(`[campaign_events] sent event failed for ${recipient.email}:`, err.message);
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

  // Clean up stuck jobs from previous crashes (OOM, restart, etc.)
  try {
    const stuckRes = await db.query(`
      UPDATE mining_jobs
      SET status = 'failed',
          error = 'Server restarted, job was stuck',
          completed_at = NOW()
      WHERE status = 'running'
        AND started_at < NOW() - INTERVAL '1 hour'
      RETURNING id, name
    `);
    if (stuckRes.rows.length > 0) {
      console.log(`[Startup] Cleaned ${stuckRes.rows.length} stuck jobs:`,
        stuckRes.rows.map(r => `${r.name} (${r.id.slice(0,8)})`).join(', '));
    } else {
      console.log('[Startup] No stuck jobs found');
    }
  } catch (err) {
    console.error('[Startup] Stuck job cleanup failed:', err.message);
  }

  await initSuperMiner();
  startCampaignScheduler();
  startCampaignSender();
  startVerificationProcessor().catch(err => {
    console.error("[Verification] FATAL: Verification processor crashed:", err.message, err.stack);
  });

  while (true) {
    await processNextJob();
    await checkStaleJobs();
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
  // Timeout guard: SuperMiner must complete within 2 hours or we abort
  const SM_TIMEOUT_MS = 2 * 60 * 60 * 1000;
  const smResult = await Promise.race([
    superMiner.runMiningJob(job, db),
    new Promise((_, reject) => setTimeout(() => reject(new Error('SuperMiner timeout — job exceeded 2 hour limit')), SM_TIMEOUT_MS))
  ]);

  // Save strategy metadata (miner_used, mining_mode, flow2_status) to stats JSONB
  if (smResult?.minerUsed || smResult?.flow2Status) {
    try {
      await db.query(
        `UPDATE mining_jobs SET stats = COALESCE(stats, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
        [job.id, JSON.stringify({
          miner_used: smResult.minerUsed || null,
          mining_mode: smResult.miningMode || job.config?.mining_mode || 'full',
          flow2_status: smResult.flow2Status || 'not_needed'
        })]
      );
    } catch (statsErr) {
      console.warn(`[Worker] Failed to save strategy stats: ${statsErr.message}`);
    }
  }

  // Block detection for unified engine: check actual DB results
  // smResult.blockDetected covers BLOCKED/FAILED miner statuses
  // Also check for 0 results in DB (covers empty pages, Cloudflare, etc.)
  let manualTriggered = false;
  if (smResult?.blockDetected || smResult?.status === 'FAILED' || smResult?.flow1?.contactCount <= 2) {
    const countRes = await db.query(
      'SELECT COUNT(*) as count FROM mining_results WHERE job_id = $1',
      [job.id]
    );
    const resultCount = parseInt(countRes.rows[0]?.count || 0);
    if (resultCount === 0) {
      console.log(`🚫 Unified engine: 0 mining_results for job ${job.id} — triggering manual assist`);
      await triggerManualAssist(job);
      manualTriggered = true;
    } else if (resultCount <= 2 && await looksLikeOrganizerPollution(job.input, resultCount, job.id)) {
      console.log(`🚫 Unified engine: ${resultCount} results but organizer pollution — triggering manual assist`);
      await triggerManualAssist(job);
      manualTriggered = true;
    }
  }

  // Set status='completed' if not already handled by triggerManualAssist
  if (!manualTriggered) {
    await db.query(
      `UPDATE mining_jobs SET status = 'completed', completed_at = NOW() WHERE id = $1 AND status = 'running'`,
      [job.id]
    );
    console.log(`✅ SuperMiner job ${job.id} completed`);
  }
} else {
  legacyResult = await processMiningJob(job);

  // HARD SITE + ZERO RESULT = BLOCK
  // processMiningJob now routes to unified engine internally,
  // so check both legacy format AND unified engine format AND DB count
  if (isHardSite(job.input)) {
    const countRes = await db.query(
      'SELECT COUNT(*) as count FROM mining_results WHERE job_id = $1',
      [job.id]
    );
    const resultCount = parseInt(countRes.rows[0]?.count || 0);
    if (resultCount === 0) {
      console.log("🚫 HARD SITE returned 0 mining_results – treating as BLOCK, triggering MANUAL");
      await triggerManualAssist(job);
      return;
    } else if (resultCount <= 2 && await looksLikeOrganizerPollution(job.input, resultCount, job.id)) {
      console.log(`🚫 HARD SITE: ${resultCount} results but organizer pollution — triggering MANUAL`);
      await triggerManualAssist(job);
      return;
    }
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

/**
 * Check if low-result mining looks like organizer email pollution.
 * When a site returns 1-2 results and ALL emails share a domain that
 * doesn't match the source URL's domain, it's likely the organizer's
 * footer/header email — not real exhibitor data.
 *
 * @param {string} sourceUrl - The mining job input URL
 * @param {number} resultCount - Number of mining_results in DB
 * @param {string} jobId - Job ID to query emails
 * @returns {boolean} true if results look like organizer pollution
 */
async function looksLikeOrganizerPollution(sourceUrl, resultCount, jobId) {
  if (resultCount === 0 || resultCount > 2) return false;

  let sourceDomain;
  try {
    sourceDomain = new URL(sourceUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch { return false; }

  try {
    const emailRes = await db.query(
      `SELECT DISTINCT unnest(emails) AS email
       FROM mining_results WHERE job_id = $1`,
      [jobId]
    );
    const emails = emailRes.rows.map(r => r.email).filter(Boolean);
    if (emails.length === 0) return false;

    // Check if ALL email domains differ from source domain
    const allForeign = emails.every(email => {
      const parts = email.split('@');
      if (parts.length !== 2) return false;
      const emailDomain = parts[1].toLowerCase().replace(/^www\./, '');
      // Compare: agritechnica.com vs dlg.org → different → foreign
      return !sourceDomain.includes(emailDomain) && !emailDomain.includes(sourceDomain);
    });

    if (allForeign) {
      console.log(`🔍 Organizer pollution detected: ${resultCount} results, all emails from foreign domain (${emails.join(', ')}) vs source ${sourceDomain}`);
    }
    return allForeign;
  } catch (err) {
    console.warn('[OrgPollution] Check failed:', err.message);
    return false;
  }
}

/* =========================================================
   MANUAL ASSIST (ORIGINAL BEHAVIOR)
   ========================================================= */
async function triggerManualAssist(job) {
  try {
    await db.query(
      `UPDATE mining_jobs
       SET manual_required=true, manual_reason='blocked_source',
           status='needs_manual', completed_at=NOW()
       WHERE id=$1`,
      [job.id]
    );

    const token = process.env.MINING_API_TOKEN || process.env.MANUAL_MINER_TOKEN;
    if (!token) {
      console.warn('[ManualAssist] No MINING_API_TOKEN set — cannot send email with command');
      return;
    }

    // Extract domain for subject line
    let siteDomain = 'unknown';
    try {
      siteDomain = new URL(job.input).hostname;
    } catch { /* ignore */ }

    const inputUrl = job.input || '';

    const emailText = `Hi,

Liffy detected that ${inputUrl} is blocking our cloud servers.
This typically happens with Cloudflare-protected sites, CAPTCHA challenges, or IP-based restrictions.

To mine this site, you need to run the mining tool from your local computer.
Copy and paste the command below into your terminal.


=== COPY AND PASTE THIS COMMAND INTO YOUR TERMINAL ===

cd ~/Projects/liffy-local-miner && node mine.js --job-id ${job.id} --api https://api.liffy.app/api --token ${token} --input "${inputUrl}"

===================================================


=== FIRST TIME SETUP (skip if already installed) ===

1. Install Node.js (if not installed): https://nodejs.org/en/download
2. Clone the local miner:
   git clone https://github.com/Nsueray/liffy-local-miner.git ~/Projects/liffy-local-miner
3. Install dependencies:
   cd ~/Projects/liffy-local-miner && npm install
4. Install Playwright browsers:
   npx playwright install chromium

Now run the command above.
===================================================

Job ID: ${job.id}
Site: ${inputUrl}
`;

    // Get organizer admin email
    let recipientEmail = 'suer@elan-expo.com'; // default fallback
    try {
      const orgResult = await db.query(
        `SELECT u.email FROM users u
         JOIN organizers o ON o.id = u.organizer_id
         WHERE o.id = $1 AND u.role = 'admin'
         LIMIT 1`,
        [job.organizer_id]
      );
      if (orgResult.rows.length > 0 && orgResult.rows[0].email) {
        recipientEmail = orgResult.rows[0].email;
      }
    } catch (err) {
      console.warn('[ManualAssist] Could not fetch organizer admin email:', err.message);
    }

    await sendEmail({
      to: recipientEmail,
      fromEmail: 'noreply@liffy.app',
      fromName: 'Liffy Mining',
      subject: `⛏️ Manual Mining Required — Job ${job.id} — ${siteDomain}`,
      text: emailText
    });

    console.log(`📧 Manual mining email sent to ${recipientEmail} for job ${job.id}`);
  } catch (err) {
    // Best-effort — never break the job
    console.error('[ManualAssist] Email send error (non-fatal):', err.message);
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================================
// STALE JOB DETECTION (periodic)
// ============================================================
const STALE_CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
let lastStaleCheck = 0;

async function checkStaleJobs() {
  const now = Date.now();
  if (now - lastStaleCheck < STALE_CHECK_INTERVAL_MS) return;
  lastStaleCheck = now;

  try {
    const staleRes = await db.query(`
      UPDATE mining_jobs
      SET status = 'failed',
          error = 'Job timed out — stuck in running state for over 3 hours',
          completed_at = NOW()
      WHERE status = 'running'
        AND started_at < NOW() - INTERVAL '3 hours'
        AND (manual_required IS NULL OR manual_required = false)
      RETURNING id, name, input, organizer_id, started_at
    `);

    if (staleRes.rows.length === 0) return;

    console.log(`[StaleCheck] Cleaned ${staleRes.rows.length} stale jobs:`,
      staleRes.rows.map(r => `${r.name || 'unnamed'} (${r.id.slice(0,8)})`).join(', '));

    // Send notification email for each stale job
    for (const job of staleRes.rows) {
      try {
        let siteDomain = 'unknown';
        try { siteDomain = new URL(job.input).hostname; } catch { /* ignore */ }

        const hoursStuck = Math.round((Date.now() - new Date(job.started_at).getTime()) / 3600000);

        let recipientEmail = 'suer@elan-expo.com';
        try {
          const orgResult = await db.query(
            `SELECT u.email FROM users u
             JOIN organizers o ON o.id = u.organizer_id
             WHERE o.id = $1 AND u.role = 'admin'
             LIMIT 1`,
            [job.organizer_id]
          );
          if (orgResult.rows.length > 0 && orgResult.rows[0].email) {
            recipientEmail = orgResult.rows[0].email;
          }
        } catch { /* use fallback */ }

        await sendEmail({
          to: recipientEmail,
          fromEmail: 'noreply@liffy.app',
          fromName: 'Liffy Mining',
          subject: `⚠️ Stale Job Cleaned — ${siteDomain} (stuck ${hoursStuck}h)`,
          text: `A mining job was stuck in "running" state for ${hoursStuck}+ hours and has been automatically marked as failed.\n\nJob: ${job.name || 'unnamed'}\nSite: ${job.input || 'N/A'}\nJob ID: ${job.id}\nStarted: ${job.started_at}\n\nYou can retry this job from the Mining Jobs page:\n${job.input || 'N/A'}`
        });

        console.log(`[StaleCheck] Notification sent to ${recipientEmail} for stale job ${job.id.slice(0,8)}`);
      } catch (emailErr) {
        console.warn(`[StaleCheck] Email notification failed for ${job.id.slice(0,8)}:`, emailErr.message);
      }
    }
  } catch (err) {
    console.error('[StaleCheck] Failed:', err.message);
  }
}
startWorker();
