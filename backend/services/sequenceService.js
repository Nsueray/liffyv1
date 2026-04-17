/**
 * sequenceService.js — Multi-touch campaign sequence business logic.
 *
 * Handles: initialization, per-step sending, reply/bounce/unsubscribe handling.
 * Uses existing campaignSend patterns: SendGrid API, template processing, compliance.
 */

const db = require('../db');
const { sendEmail } = require('../mailer');
const { processTemplate, convertPlainTextToHtml } = require('../utils/templateProcessor');
const {
  processEmailCompliance,
  getUnsubscribeUrl,
  getListUnsubscribeHeaders
} = require('../utils/unsubscribeHelper');

// ---------------------------------------------------------------------------
// initializeSequence — populate sequence_recipients from resolved campaign_recipients
// ---------------------------------------------------------------------------
async function initializeSequence(campaignId, organizerId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1) Verify campaign exists and has sequence steps
    const campRes = await client.query(
      `SELECT id, status, list_id FROM campaigns
       WHERE id = $1 AND organizer_id = $2`,
      [campaignId, organizerId]
    );
    if (campRes.rows.length === 0) throw new Error('Campaign not found');
    const campaign = campRes.rows[0];

    const stepsRes = await client.query(
      `SELECT id, sequence_order, delay_days FROM campaign_sequences
       WHERE campaign_id = $1 AND organizer_id = $2 AND is_active = TRUE
       ORDER BY sequence_order ASC`,
      [campaignId, organizerId]
    );
    if (stepsRes.rows.length === 0) throw new Error('No active sequence steps');

    const firstStep = stepsRes.rows[0];

    // 2) Get resolved recipients (campaign_recipients already populated by resolve)
    const recipRes = await client.query(
      `SELECT DISTINCT ON (LOWER(email)) email, person_id, name, meta
       FROM campaign_recipients
       WHERE campaign_id = $1 AND organizer_id = $2
       ORDER BY LOWER(email), created_at ASC`,
      [campaignId, organizerId]
    );

    if (recipRes.rows.length === 0) throw new Error('No recipients found — resolve campaign first');

    // 3) Delete existing sequence_recipients (re-init safe)
    await client.query(
      `DELETE FROM sequence_recipients WHERE campaign_id = $1 AND organizer_id = $2`,
      [campaignId, organizerId]
    );

    // 4) Batch insert sequence_recipients
    const now = new Date().toISOString();
    const values = [];
    const placeholders = [];

    recipRes.rows.forEach((r, idx) => {
      const base = idx * 5;
      placeholders.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, 1, 'active', NOW(), 0)`
      );
      values.push(organizerId, campaignId, r.person_id || null, r.email, JSON.stringify(r.meta || {}));
    });

    await client.query(
      `INSERT INTO sequence_recipients
         (organizer_id, campaign_id, person_id, email, meta, current_step, status, next_send_at, last_sent_step)
       VALUES ${placeholders.join(', ')}`,
      values
    );

    // 5) Update campaign
    await client.query(
      `UPDATE campaigns
       SET campaign_type = 'sequence', status = 'sending'
       WHERE id = $1 AND organizer_id = $2`,
      [campaignId, organizerId]
    );

    await client.query('COMMIT');

    return {
      success: true,
      recipient_count: recipRes.rows.length,
      step_count: stepsRes.rows.length
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// processSequenceStep — send one email for one recipient at their current step
// ---------------------------------------------------------------------------
async function processSequenceStep(seqRecipient) {
  const { id, campaign_id, organizer_id, email, current_step, meta } = seqRecipient;

  // 1) Get step definition
  const stepRes = await db.query(
    `SELECT cs.*, t.subject, t.body_html, t.body_text
     FROM campaign_sequences cs
     JOIN email_templates t ON t.id = cs.template_id
     WHERE cs.campaign_id = $1 AND cs.organizer_id = $2 AND cs.sequence_order = $3 AND cs.is_active = TRUE`,
    [campaign_id, organizer_id, current_step]
  );

  if (stepRes.rows.length === 0) {
    // No more steps or step deactivated — complete
    await db.query(
      `UPDATE sequence_recipients SET status = 'completed', next_send_at = NULL, updated_at = NOW() WHERE id = $1`,
      [id]
    );

    // Action Engine: evaluate sequence_exhausted trigger (best-effort)
    try {
      const actionEngine = require('../engines/action-engine/actionEngine');
      if (seqRecipient.person_id) {
        await actionEngine.evaluateForPerson(seqRecipient.person_id, organizer_id, 'sequence_exhausted');
      }
    } catch (aeErr) {
      console.error('[ActionEngine] Sequence exhausted trigger failed:', aeErr.message);
    }

    return { action: 'completed', reason: 'no_step_found' };
  }

  const step = stepRes.rows[0];

  // 2) Condition check
  if (step.condition === 'no_reply') {
    const replyCheck = await db.query(
      `SELECT 1 FROM campaign_events
       WHERE campaign_id = $1 AND LOWER(email) = LOWER($2) AND event_type = 'reply'
       LIMIT 1`,
      [campaign_id, email]
    );
    if (replyCheck.rows.length > 0) {
      await db.query(
        `UPDATE sequence_recipients SET status = 'replied', next_send_at = NULL, updated_at = NOW() WHERE id = $1`,
        [id]
      );
      return { action: 'skipped', reason: 'replied' };
    }
  } else if (step.condition === 'no_open') {
    const openCheck = await db.query(
      `SELECT 1 FROM campaign_events
       WHERE campaign_id = $1 AND LOWER(email) = LOWER($2) AND event_type = 'open'
       LIMIT 1`,
      [campaign_id, email]
    );
    if (openCheck.rows.length > 0) {
      await db.query(
        `UPDATE sequence_recipients SET status = 'completed', next_send_at = NULL, updated_at = NOW() WHERE id = $1`,
        [id]
      );
      return { action: 'skipped', reason: 'opened' };
    }
  }
  // 'always' — no check needed

  // 3) Get campaign + sender + organizer
  const campRes = await db.query(
    `SELECT c.*, s.from_email, s.from_name, s.reply_to AS sender_reply_to,
            o.sendgrid_api_key, o.physical_address
     FROM campaigns c
     LEFT JOIN sender_identities s ON c.sender_id = s.id
     LEFT JOIN organizers o ON c.organizer_id = o.id
     WHERE c.id = $1 AND c.organizer_id = $2`,
    [campaign_id, organizer_id]
  );
  if (campRes.rows.length === 0) return { action: 'error', reason: 'campaign_not_found' };

  const campaign = campRes.rows[0];
  if (!campaign.sendgrid_api_key) return { action: 'error', reason: 'no_sendgrid_key' };
  if (!campaign.from_email) return { action: 'error', reason: 'no_sender' };

  // 4) Build recipient object for template processing
  const parsedMeta = typeof meta === 'string' ? JSON.parse(meta || '{}') : (meta || {});
  const recipient = {
    email,
    name: parsedMeta.name || parsedMeta.first_name || '',
    meta: parsedMeta
  };

  // 5) Process template
  const unsubscribe_url = getUnsubscribeUrl(email, organizer_id, campaign_id, id);
  const subject = step.subject_override || step.subject;
  const personalizedSubject = processTemplate(subject, recipient);
  let personalizedHtml = processTemplate(step.body_html, recipient, { unsubscribe_url });
  const personalizedText = processTemplate(step.body_text || '', recipient, { unsubscribe_url });

  personalizedHtml = convertPlainTextToHtml(personalizedHtml);

  // 6) Compliance pipeline
  const compliance = processEmailCompliance({
    html: personalizedHtml,
    text: personalizedText,
    recipientEmail: email,
    organizerId: organizer_id,
    campaignId: campaign_id,
    recipientId: id,
    physicalAddress: campaign.physical_address || '',
    lang: 'en'
  });

  // 7) Headers
  const unsubHeaders = getListUnsubscribeHeaders(email, organizer_id, campaign.from_email, campaign_id, id);

  // 8) Reply-To = salesperson's real email (customer replies go directly to their inbox)
  // Reply detection relies on unsubscribe URL in quoted body (parsed by inbound handler)
  const replyToAddr = campaign.sender_reply_to || campaign.from_email;

  // 9) Send via SendGrid
  const mailResult = await sendEmail({
    to: email,
    subject: personalizedSubject,
    text: compliance.text,
    html: compliance.html,
    from_name: campaign.from_name,
    from_email: campaign.from_email,
    reply_to: replyToAddr,
    sendgrid_api_key: campaign.sendgrid_api_key,
    headers: unsubHeaders
  });

  if (!mailResult.success) {
    console.error(`[Sequence] Send failed for ${email} step ${current_step}:`, mailResult.error);
    return { action: 'error', reason: mailResult.error };
  }

  // 10) Record sent event
  try {
    // Find person_id
    let personId = seqRecipient.person_id;
    if (!personId) {
      const pRes = await db.query(
        `SELECT id FROM persons WHERE LOWER(email) = LOWER($1) AND organizer_id = $2 LIMIT 1`,
        [email, organizer_id]
      );
      if (pRes.rows.length > 0) personId = pRes.rows[0].id;
    }

    await db.query(
      `INSERT INTO campaign_events
         (organizer_id, campaign_id, person_id, event_type, email, occurred_at)
       VALUES ($1, $2, $3, 'sent', $4, NOW())`,
      [organizer_id, campaign_id, personId, email]
    );
  } catch (evErr) {
    console.error('[Sequence] Failed to record sent event:', evErr.message);
  }

  // 11) Advance sequence_recipient to next step
  const nextStepRes = await db.query(
    `SELECT sequence_order, delay_days FROM campaign_sequences
     WHERE campaign_id = $1 AND organizer_id = $2 AND sequence_order > $3 AND is_active = TRUE
     ORDER BY sequence_order ASC LIMIT 1`,
    [campaign_id, organizer_id, current_step]
  );

  if (nextStepRes.rows.length > 0) {
    const next = nextStepRes.rows[0];
    await db.query(
      `UPDATE sequence_recipients
       SET current_step = $2, last_sent_step = $3, last_sent_at = NOW(),
           next_send_at = NOW() + ($4 || ' days')::INTERVAL, updated_at = NOW()
       WHERE id = $1`,
      [id, next.sequence_order, current_step, next.delay_days]
    );
  } else {
    // Last step — mark completed
    await db.query(
      `UPDATE sequence_recipients
       SET status = 'completed', last_sent_step = $2, last_sent_at = NOW(),
           next_send_at = NULL, updated_at = NOW()
       WHERE id = $1`,
      [id, current_step]
    );

    // Action Engine: evaluate sequence_exhausted trigger (best-effort)
    try {
      const actionEngine = require('../engines/action-engine/actionEngine');
      if (seqRecipient.person_id) {
        await actionEngine.evaluateForPerson(seqRecipient.person_id, organizer_id, 'sequence_exhausted');
      }
    } catch (aeErr) {
      console.error('[ActionEngine] Sequence exhausted trigger failed:', aeErr.message);
    }
  }

  return { action: 'sent', step: current_step };
}

// ---------------------------------------------------------------------------
// handleReply — stop sequence for this recipient
// ---------------------------------------------------------------------------
async function handleReply(email, campaignId, organizerId) {
  await db.query(
    `UPDATE sequence_recipients
     SET status = 'replied', next_send_at = NULL, updated_at = NOW()
     WHERE campaign_id = $1 AND organizer_id = $2 AND LOWER(email) = LOWER($3) AND status = 'active'`,
    [campaignId, organizerId, email]
  );
}

// ---------------------------------------------------------------------------
// handleBounce — stop sequence for this recipient
// ---------------------------------------------------------------------------
async function handleBounce(email, campaignId) {
  await db.query(
    `UPDATE sequence_recipients
     SET status = 'bounced', next_send_at = NULL, updated_at = NOW()
     WHERE campaign_id = $1 AND LOWER(email) = LOWER($2) AND status = 'active'`,
    [campaignId, email]
  );
}

// ---------------------------------------------------------------------------
// handleUnsubscribe — stop ALL active sequences for this email in this organizer
// ---------------------------------------------------------------------------
async function handleUnsubscribe(email, organizerId) {
  await db.query(
    `UPDATE sequence_recipients
     SET status = 'unsubscribed', next_send_at = NULL, updated_at = NOW()
     WHERE organizer_id = $1 AND LOWER(email) = LOWER($2) AND status = 'active'`,
    [organizerId, email]
  );
}

// ---------------------------------------------------------------------------
// pauseSequence / resumeSequence — bulk status updates
// ---------------------------------------------------------------------------
async function pauseSequence(campaignId, organizerId) {
  const res = await db.query(
    `UPDATE sequence_recipients
     SET status = 'paused', updated_at = NOW()
     WHERE campaign_id = $1 AND organizer_id = $2 AND status = 'active'
     RETURNING id`,
    [campaignId, organizerId]
  );

  await db.query(
    `UPDATE campaigns SET status = 'paused' WHERE id = $1 AND organizer_id = $2`,
    [campaignId, organizerId]
  );

  return { paused_count: res.rowCount };
}

async function resumeSequence(campaignId, organizerId) {
  // Resume paused recipients — recalculate next_send_at based on current step's delay
  const res = await db.query(
    `UPDATE sequence_recipients sr
     SET status = 'active',
         next_send_at = CASE
           WHEN sr.last_sent_at IS NOT NULL
             THEN sr.last_sent_at + (
               COALESCE((
                 SELECT cs.delay_days FROM campaign_sequences cs
                 WHERE cs.campaign_id = sr.campaign_id AND cs.sequence_order = sr.current_step
               ), 0)::TEXT || ' days')::INTERVAL
           ELSE NOW()
         END,
         updated_at = NOW()
     WHERE campaign_id = $1 AND organizer_id = $2 AND status = 'paused'
     RETURNING id`,
    [campaignId, organizerId]
  );

  await db.query(
    `UPDATE campaigns SET status = 'sending' WHERE id = $1 AND organizer_id = $2`,
    [campaignId, organizerId]
  );

  return { resumed_count: res.rowCount };
}

// ---------------------------------------------------------------------------
// getSequenceAnalytics — per-step + overall stats
// ---------------------------------------------------------------------------
async function getSequenceAnalytics(campaignId, organizerId) {
  // Per-step stats from campaign_events
  // We track which step sent each email by correlating send timestamps
  // with sequence_recipients.last_sent_step

  // Overall recipient status breakdown
  const statusRes = await db.query(
    `SELECT status, COUNT(*) AS count
     FROM sequence_recipients
     WHERE campaign_id = $1 AND organizer_id = $2
     GROUP BY status`,
    [campaignId, organizerId]
  );

  const statusBreakdown = {};
  let totalRecipients = 0;
  for (const row of statusRes.rows) {
    statusBreakdown[row.status] = parseInt(row.count, 10);
    totalRecipients += parseInt(row.count, 10);
  }

  // Per-step sent counts
  const stepRes = await db.query(
    `SELECT
       cs.sequence_order,
       cs.delay_days,
       cs.condition,
       t.name AS template_name,
       t.subject AS template_subject,
       cs.subject_override,
       COUNT(sr.id) FILTER (WHERE sr.last_sent_step >= cs.sequence_order) AS sent_count
     FROM campaign_sequences cs
     JOIN email_templates t ON t.id = cs.template_id
     LEFT JOIN sequence_recipients sr ON sr.campaign_id = cs.campaign_id AND sr.organizer_id = cs.organizer_id
     WHERE cs.campaign_id = $1 AND cs.organizer_id = $2 AND cs.is_active = TRUE
     GROUP BY cs.id, cs.sequence_order, cs.delay_days, cs.condition, t.name, t.subject, cs.subject_override
     ORDER BY cs.sequence_order ASC`,
    [campaignId, organizerId]
  );

  // Per-step engagement from campaign_events (approximate — grouped by time windows)
  // For now, provide total campaign-level engagement
  const engagementRes = await db.query(
    `SELECT event_type, COUNT(DISTINCT email) AS unique_count
     FROM campaign_events
     WHERE campaign_id = $1 AND organizer_id = $2
     GROUP BY event_type`,
    [campaignId, organizerId]
  );

  const engagement = {};
  for (const row of engagementRes.rows) {
    engagement[row.event_type] = parseInt(row.unique_count, 10);
  }

  return {
    total_recipients: totalRecipients,
    status_breakdown: statusBreakdown,
    steps: stepRes.rows.map(s => ({
      step: s.sequence_order,
      template_name: s.template_name,
      template_subject: s.subject_override || s.template_subject,
      delay_days: s.delay_days,
      condition: s.condition,
      sent: parseInt(s.sent_count, 10)
    })),
    engagement: {
      sent: engagement.sent || 0,
      opened: engagement.open || 0,
      clicked: engagement.click || 0,
      replied: engagement.reply || 0,
      bounced: engagement.bounce || 0
    }
  };
}

module.exports = {
  initializeSequence,
  processSequenceStep,
  handleReply,
  handleBounce,
  handleUnsubscribe,
  pauseSequence,
  resumeSequence,
  getSequenceAnalytics
};
