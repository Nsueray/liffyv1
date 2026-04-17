const express = require('express');
const router = express.Router();
const db = require('../db');
// sendEmail + sgMail no longer needed — Liffy no longer forwards replies
const multer = require('multer');
const upload = multer();

// ============================================================
// IMPORT SHARED UNSUBSCRIBE UTILITY
// ============================================================
const {
  generateUnsubscribeToken,
  verifyUnsubscribeToken,
  getUnsubscribeUrl
} = require('../utils/unsubscribeHelper');

// Sequence hooks (best-effort, never breaks webhook flow)
let sequenceService;
try {
  sequenceService = require('../services/sequenceService');
} catch (e) {
  console.warn('[Webhooks] sequenceService not available:', e.message);
}

// Action Engine hooks (best-effort, never breaks webhook flow)
let actionEngine;
try {
  actionEngine = require('../engines/action-engine/actionEngine');
} catch (e) {
  console.warn('[Webhooks] actionEngine not available:', e.message);
}

// ============================================================
// SENDGRID WEBHOOK
// ============================================================

/**
 * POST /api/webhooks/sendgrid
 * Receives events from SendGrid (delivered, open, click, bounce, etc.)
 * 
 * SendGrid sends an array of events in the body.
 * Each event has: email, event, sg_message_id, timestamp, etc.
 */
router.post('/api/webhooks/sendgrid', async (req, res) => {
  try {
    const events = req.body;

    // SendGrid sends array of events
    if (!Array.isArray(events)) {
      console.log('⚠️ SendGrid webhook: invalid payload (not array)');
      return res.status(200).send('OK'); // Always return 200 to SendGrid
    }

    console.log(`📬 SendGrid webhook received: ${events.length} event(s)`);

    for (const event of events) {
      try {
        await processWebhookEvent(event);
      } catch (err) {
        console.error(`❌ Error processing event for ${event.email}:`, err.message);
        // Continue processing other events
      }
    }

    // Always return 200 to prevent SendGrid retries
    return res.status(200).send('OK');

  } catch (err) {
    console.error('❌ SendGrid webhook error:', err.message);
    return res.status(200).send('OK'); // Still return 200
  }
});

/**
 * Map SendGrid event types to campaign_events.event_type
 */
const CAMPAIGN_EVENT_TYPE_MAP = {
  'delivered': 'delivered',
  'open': 'open',
  'click': 'click',
  'bounce': 'bounce',
  'dropped': 'dropped',
  'deferred': 'deferred',
  'spamreport': 'spam_report',
  'unsubscribe': 'unsubscribe',
  'reply': 'reply',
};

/**
 * Process individual SendGrid event
 */
async function processWebhookEvent(event) {
  const { email, event: eventType, timestamp, sg_message_id, reason, bounce_classification } = event;

  if (!email || !eventType) {
    return; // Skip invalid events
  }

  const eventTime = timestamp ? new Date(timestamp * 1000) : new Date();

  console.log(`  📧 ${eventType.toUpperCase()} - ${email}`);

  // Map SendGrid event to our status
  const statusMap = {
    'delivered': 'delivered',
    'open': 'opened',
    'click': 'clicked',
    'bounce': 'bounced',
    'dropped': 'failed',
    'spamreport': 'bounced',
    'unsubscribe': 'unsubscribed'
  };

  const newStatus = statusMap[eventType];
  if (!newStatus) {
    return; // Unknown event type, skip
  }

  // Find the recipient by email (most recent campaign first)
  // We match by email since sg_message_id might not be stored
  const recipientRes = await db.query(
    `SELECT cr.id, cr.campaign_id, cr.organizer_id, cr.status
     FROM campaign_recipients cr
     WHERE LOWER(cr.email) = LOWER($1)
       AND cr.status IN ('sent', 'delivered', 'opened', 'clicked')
     ORDER BY cr.sent_at DESC NULLS LAST
     LIMIT 1`,
    [email]
  );

  if (recipientRes.rows.length === 0) {
    // Try to find any recipient with this email
    const anyRecipient = await db.query(
      `SELECT cr.id, cr.campaign_id, cr.organizer_id, cr.status
       FROM campaign_recipients cr
       WHERE LOWER(cr.email) = LOWER($1)
       ORDER BY cr.created_at DESC
       LIMIT 1`,
      [email]
    );

    if (anyRecipient.rows.length === 0) {
      console.log(`  ⚠️ No recipient found for ${email}`);
      return;
    }
  }

  const recipient = recipientRes.rows[0] || (await db.query(
    `SELECT cr.id, cr.campaign_id, cr.organizer_id, cr.status
     FROM campaign_recipients cr
     WHERE LOWER(cr.email) = LOWER($1)
     ORDER BY cr.created_at DESC
     LIMIT 1`,
    [email]
  )).rows[0];

  if (!recipient) return;

  // Update based on event type (existing campaign_recipients flow — untouched)
  switch (eventType) {
    case 'delivered':
      await db.query(
        `UPDATE campaign_recipients
         SET status = 'delivered', delivered_at = $2
         WHERE id = $1 AND status = 'sent' AND status NOT IN ('replied', 'unsubscribed')`,
        [recipient.id, eventTime]
      );
      break;

    case 'open':
      await db.query(
        `UPDATE campaign_recipients
         SET status = CASE WHEN status IN ('replied', 'unsubscribed') THEN status ELSE 'opened' END,
             opened_at = COALESCE(opened_at, $2),
             open_count = COALESCE(open_count, 0) + 1
         WHERE id = $1`,
        [recipient.id, eventTime]
      );
      break;

    case 'click':
      await db.query(
        `UPDATE campaign_recipients
         SET status = CASE WHEN status IN ('replied', 'unsubscribed') THEN status ELSE 'clicked' END,
             clicked_at = COALESCE(clicked_at, $2),
             click_count = COALESCE(click_count, 0) + 1
         WHERE id = $1`,
        [recipient.id, eventTime]
      );
      break;

    case 'bounce':
    case 'dropped':
      const errorMsg = reason || bounce_classification || eventType;
      await db.query(
        `UPDATE campaign_recipients
         SET status = 'bounced',
             bounced_at = $2,
             last_error = $3
         WHERE id = $1`,
        [recipient.id, eventTime, errorMsg]
      );
      // Sequence hook: stop sequence for bounced recipient
      try { if (sequenceService) await sequenceService.handleBounce(email, recipient.campaign_id); } catch (e) { /* best-effort */ }
      break;

    case 'spamreport':
      await db.query(
        `UPDATE campaign_recipients
         SET status = 'bounced',
             bounced_at = $2,
             last_error = 'Spam report'
         WHERE id = $1`,
        [recipient.id, eventTime]
      );
      // Also add to unsubscribe list
      await addToUnsubscribeList(recipient.organizer_id, email, 'spam_report');
      // Sequence hook: stop all sequences for this email
      try { if (sequenceService) await sequenceService.handleUnsubscribe(email, recipient.organizer_id); } catch (e) { /* best-effort */ }
      break;

    case 'unsubscribe':
      await addToUnsubscribeList(recipient.organizer_id, email, 'sendgrid_unsubscribe');
      // Sequence hook: stop all sequences for this email
      try { if (sequenceService) await sequenceService.handleUnsubscribe(email, recipient.organizer_id); } catch (e) { /* best-effort */ }
      break;
  }

  // Record to canonical campaign_events table (Phase 2)
  await recordCampaignEvent(recipient, email, eventType, eventTime, event);

  // Record prospect intent for intent-bearing events (Phase 2)
  await recordProspectIntent(recipient, email, eventType, eventTime);

  // Action Engine: evaluate triggers for reply, open, click events
  if (actionEngine && ['reply', 'open', 'click'].includes(eventType)) {
    try {
      const personRes = await db.query(
        `SELECT id FROM persons WHERE organizer_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1`,
        [recipient.organizer_id, email]
      );
      if (personRes.rows.length > 0) {
        const hint = eventType === 'reply' ? 'reply_received' : 'engaged_hot';
        await actionEngine.evaluateForPerson(personRes.rows[0].id, recipient.organizer_id, hint);
      }
    } catch (aeErr) {
      console.error('[ActionEngine] Webhook trigger failed:', aeErr.message);
    }
  }
}

/**
 * Record event to canonical campaign_events table.
 * Never breaks the main webhook flow — all errors are caught and logged.
 */
async function recordCampaignEvent(recipient, email, eventType, eventTime, rawEvent) {
  const canonicalType = CAMPAIGN_EVENT_TYPE_MAP[eventType];
  if (!canonicalType) return;

  try {
    // Best-effort person_id lookup from canonical persons table
    let personId = null;
    const personRes = await db.query(
      `SELECT id FROM persons WHERE organizer_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1`,
      [recipient.organizer_id, email]
    );
    if (personRes.rows.length > 0) {
      personId = personRes.rows[0].id;
    }

    await db.query(`
      INSERT INTO campaign_events (
        organizer_id, campaign_id, recipient_id, person_id,
        event_type, email, url, user_agent, ip_address,
        reason, provider_event_id, provider_response, occurred_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (campaign_id, event_type, LOWER(email), provider_event_id)
        WHERE provider_event_id IS NOT NULL
      DO NOTHING
    `, [
      recipient.organizer_id,
      recipient.campaign_id,
      recipient.id,
      personId,
      canonicalType,
      email,
      rawEvent.url || null,
      rawEvent.useragent || null,
      rawEvent.ip || null,
      rawEvent.reason || rawEvent.bounce_classification || null,
      rawEvent.sg_message_id || null,
      JSON.stringify(rawEvent),
      eventTime,
    ]);
  } catch (err) {
    // Never break the webhook flow — log and continue
    console.error(`  ⚠️ campaign_events insert failed for ${email}:`, err.message);
  }
}

/**
 * Record prospect intent for intent-bearing webhook events.
 * Constitution: "A prospect is a person who has demonstrated intent (reply, form submission, manual qualification)."
 *
 * Intent-bearing events:
 *   - reply      → intent_type: 'reply'
 *   - click      → intent_type: 'click_through'  (clicked CTA = interest signal)
 *
 * Never breaks the main webhook flow — all errors are caught and logged.
 */
const INTENT_TYPE_MAP = {
  'reply': 'reply',
  'click': 'click_through',
};

async function recordProspectIntent(recipient, email, eventType, eventTime) {
  const intentType = INTENT_TYPE_MAP[eventType];
  if (!intentType) return; // Not an intent-bearing event

  try {
    // Require person_id — no person means no intent record
    const personRes = await db.query(
      `SELECT id FROM persons WHERE organizer_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1`,
      [recipient.organizer_id, email]
    );

    if (personRes.rows.length === 0) return;

    const personId = personRes.rows[0].id;

    await db.query(`
      INSERT INTO prospect_intents (
        organizer_id, person_id, campaign_id,
        intent_type, source, occurred_at
      ) VALUES ($1, $2, $3, $4, 'webhook', $5)
      ON CONFLICT (organizer_id, person_id, COALESCE(campaign_id::text, ''), intent_type) DO NOTHING
    `, [
      recipient.organizer_id,
      personId,
      recipient.campaign_id,
      intentType,
      eventTime,
    ]);
  } catch (err) {
    // Never break the webhook flow
    console.error(`  ⚠️ prospect_intent insert failed for ${email}:`, err.message);
  }
}

/**
 * Helper: Add email to unsubscribe list
 */
async function addToUnsubscribeList(organizerId, email, source = 'webhook') {
  try {
    await db.query(
      `INSERT INTO unsubscribes (organizer_id, email, source, created_at)
       VALUES ($1, LOWER($2), $3, NOW())
       ON CONFLICT (organizer_id, email) DO NOTHING`,
      [organizerId, email, source]
    );
    console.log(`  🚫 Added ${email} to unsubscribe list (${source})`);
  } catch (err) {
    console.error(`  ❌ Failed to add to unsubscribe list:`, err.message);
  }
}


// ============================================================
// INBOUND EMAIL (REPLY DETECTION) — Stage 1 Backend Preparation
// ============================================================

/**
 * Parse VERP (Variable Envelope Return Path) address.
 * Short format: c-{8 hex}-r-{8 hex}@reply.liffy.app
 * The 8 hex chars are the first 8 chars of the UUID (campaign_id and recipient_id).
 * RFC 5321 safe: local-part = 22 chars (well under 64 limit).
 * Returns { campaignShort, recipientShort } or null if not a valid VERP address.
 */
function parseVerpAddress(address) {
  if (!address || typeof address !== 'string') return null;
  const match = address.match(/^c-([a-f0-9]{8})-r-([a-f0-9]{8})@reply\.liffy\.app$/i);
  if (!match) return null;
  const campaignShort = match[1].toLowerCase();
  const recipientShort = match[2].toLowerCase();
  return { campaignShort, recipientShort };
}

/**
 * Parse hidden LIFFY tracking comment from email body.
 * Format: <!--LIFFY:c-{8hex}-r-{8hex}--> or <!--LIFFY:c-{8hex}-sr-{8hex}-->
 * The comment is injected into outbound emails for reply detection via Gmail auto-forward.
 * Returns { campaignShort, recipientShort } or null if not found.
 */
function parseLiffyTag(body) {
  if (!body || typeof body !== 'string') return null;
  const match = body.match(/<!--LIFFY:c-([a-f0-9]{8})-s?r-([a-f0-9]{8})-->/i);
  if (!match) return null;
  return { campaignShort: match[1].toLowerCase(), recipientShort: match[2].toLowerCase() };
}

/**
 * Detect auto-replies (OOO, mailer-daemon, noreply, etc.) to avoid
 * creating false prospect intents.
 *
 * Checks:
 * 1. Headers: Auto-Submitted, X-Auto-Response-Suppress, Precedence
 * 2. Subject patterns: OOO, Out of Office, Automatic reply, etc.
 * 3. From patterns: mailer-daemon, noreply, postmaster
 */
function isAutoReply({ subject, headers, from }) {
  // Header checks (SendGrid Inbound Parse passes headers as a string blob)
  if (headers) {
    const h = headers.toLowerCase();
    // RFC 3834 Auto-Submitted (any value other than "no" means auto)
    if (/auto-submitted:\s*(?!no\b)\S+/i.test(h)) return true;
    if (/x-auto-response-suppress:/i.test(h)) return true;
    if (/precedence:\s*(bulk|junk|auto[_-]?reply)/i.test(h)) return true;
  }

  // Subject patterns
  if (subject) {
    const s = subject.toLowerCase();
    const autoPatterns = [
      'out of office',
      'automatic reply',
      'auto-reply',
      'autoreply',
      'away from office',
      'on vacation',
      'delivery status notification',
      'undeliverable',
      'mail delivery failed',
      'delivery failure',
    ];
    for (const pattern of autoPatterns) {
      if (s.includes(pattern)) return true;
    }
    // OOO shorthand (exact or at start)
    if (/^ooo[\s:]/i.test(subject) || subject.trim().toLowerCase() === 'ooo') return true;
  }

  // From patterns
  if (from) {
    const f = from.toLowerCase();
    const noReplyPatterns = ['mailer-daemon', 'noreply', 'no-reply', 'postmaster', 'mail-daemon'];
    for (const pattern of noReplyPatterns) {
      if (f.includes(pattern)) return true;
    }
  }

  return false;
}


/**
 * POST /api/webhooks/inbound/:secret
 * Receives inbound emails from SendGrid Inbound Parse.
 * SendGrid POSTs multipart/form-data with fields: from, to, subject, text, html, headers, envelope, etc.
 *
 * Security: Secret is embedded in the URL path (INBOUND_WEBHOOK_SECRET env var).
 * SendGrid Inbound Parse URL must be configured as:
 *   https://api.liffy.app/api/webhooks/inbound/{INBOUND_WEBHOOK_SECRET}
 * Envelope domain validation ensures only @reply.liffy.app emails are processed.
 *
 * Flow:
 * 1. Validate shared secret
 * 2. Extract tracking IDs: hidden comment tag in body (primary) or VERP envelope (fallback)
 * 3. Filter auto-replies
 * 4. Look up campaign_recipient by short IDs
 * 5. Record reply as campaign_event (event_type='reply')
 * 6. Record prospect_intent (intent_type='reply')
 * 7. Update status, contact_activities, pipeline auto-stage
 * 8. NO forward — salesperson already has the reply in their inbox (Reply-To = their email)
 */
router.post(
  '/api/webhooks/inbound/:secret',
  upload.none(),
  async (req, res) => {
  try {
    // Security: validate secret from URL path
    const expectedSecret = process.env.INBOUND_WEBHOOK_SECRET;
    if (!expectedSecret || req.params.secret !== expectedSecret) {
      console.warn('⚠️ Inbound webhook: invalid secret in URL path');
      return res.status(200).send('OK');
    }

    const { from, to, subject, text, html, headers } = req.body;

    console.log(`📨 Inbound email received — from: ${from}, to: ${to}, subject: ${subject}`);

    // 1. Extract tracking IDs — try hidden comment tag in body first, VERP envelope as fallback
    let trackingIds = null;
    let trackingSource = null;

    // 1a. Primary: hidden comment tag in HTML or text body (works with Gmail auto-forward)
    trackingIds = parseLiffyTag(html) || parseLiffyTag(text);
    if (trackingIds) {
      trackingSource = 'tag';
      console.log(`  🏷️ Liffy tag found — campaign: ${trackingIds.campaignShort}, recipient: ${trackingIds.recipientShort}`);
    }

    // 1b. Fallback: VERP envelope address (legacy, for emails already in flight)
    if (!trackingIds) {
      const envelope = typeof req.body.envelope === 'string'
        ? JSON.parse(req.body.envelope || '{}')
        : req.body.envelope || {};

      const toAddresses = Array.isArray(envelope?.to)
        ? envelope.to
        : [envelope?.to].filter(Boolean);

      for (const addr of toAddresses) {
        const parsed = parseVerpAddress(addr);
        if (parsed) {
          trackingIds = parsed;
          trackingSource = 'verp';
          break;
        }
      }

      // Try the to field directly
      if (!trackingIds && to) {
        const toFallback = to.split(',').map(a => a.trim());
        for (const addr of toFallback) {
          const emailMatch = addr.match(/<([^>]+)>/) || [null, addr];
          const parsed = parseVerpAddress(emailMatch[1]);
          if (parsed) {
            trackingIds = parsed;
            trackingSource = 'verp';
            break;
          }
        }
      }

      if (trackingIds) {
        console.log(`  🔗 VERP fallback — campaign: ${trackingIds.campaignShort}, recipient: ${trackingIds.recipientShort}`);
      }
    }

    if (!trackingIds) {
      console.log('  ⚠️ No tracking IDs found (no tag, no VERP) — skipping');
      return res.status(200).send('OK');
    }

    // 2. Filter auto-replies
    if (isAutoReply({ subject, headers, from })) {
      console.log(`  🤖 Auto-reply detected — skipping (subject: "${subject}", from: ${from})`);
      return res.status(200).send('OK');
    }

    // 3. Look up campaign_recipient by short prefix match (LIMIT 2 for collision detection)
    const recipientRes = await db.query(
      `SELECT cr.id, cr.campaign_id, cr.organizer_id, cr.email, cr.status
       FROM campaign_recipients cr
       WHERE LEFT(cr.campaign_id::text, 8) = $1
         AND LEFT(cr.id::text, 8) = $2
       LIMIT 2`,
      [trackingIds.campaignShort, trackingIds.recipientShort]
    );

    if (recipientRes.rows.length === 0) {
      console.log(`  ⚠️ No recipient found — ${trackingSource}: campaign=${trackingIds.campaignShort}, recipient=${trackingIds.recipientShort}`);
      return res.status(200).send('OK');
    }

    // Collision guard: if short prefix matches more than one row, refuse to process
    if (recipientRes.rows.length > 1) {
      console.error(`  ❌ Collision detected — short IDs not unique: campaign=${trackingIds.campaignShort}, recipient=${trackingIds.recipientShort}, matches=${recipientRes.rows.length}`);
      return res.status(200).send('OK');
    }

    const recipient = recipientRes.rows[0];
    const replyTime = new Date();

    console.log(`  ✅ Reply matched — ${recipient.email} → campaign ${recipient.campaign_id}`);

    // 4. Record reply as campaign_event
    const rawEvent = {
      from,
      to,
      subject,
      text: text ? text.substring(0, 2000) : null, // Store reply body (truncated for safety)
    };
    await recordCampaignEvent(recipient, recipient.email, 'reply', replyTime, rawEvent);

    // 5. Record prospect_intent (intent_type='reply')
    await recordProspectIntent(recipient, recipient.email, 'reply', replyTime);

    // 6. Update campaign_recipient status to 'replied'
    try {
      await db.query(
        `UPDATE campaign_recipients SET status = 'replied', replied_at = $2 WHERE id = $1`,
        [recipient.id, replyTime]
      );
    } catch (statusErr) {
      console.warn(`  ⚠️ Failed to update recipient status to replied:`, statusErr.message);
    }

    console.log(`  📝 Reply recorded for ${recipient.email} (campaign: ${recipient.campaign_id})`);

    // Best-effort contact_activities hook — resolve person_id via email + organizer
    try {
      const personRes = await db.query(
        `SELECT id, pipeline_stage_id FROM persons
          WHERE organizer_id = $1 AND LOWER(email) = LOWER($2)
          LIMIT 1`,
        [recipient.organizer_id, recipient.email]
      );
      if (personRes.rows.length > 0) {
        const person = personRes.rows[0];
        await db.query(
          `INSERT INTO contact_activities
             (organizer_id, person_id, activity_type, description, meta, occurred_at)
           VALUES ($1, $2, 'email_replied', $3, $4, $5)`,
          [
            recipient.organizer_id,
            person.id,
            (subject || '').substring(0, 200),
            JSON.stringify({ campaign_id: recipient.campaign_id, from, subject }),
            replyTime,
          ]
        );

        // Auto-stage: if person is unassigned, New, or Contacted → move to Interested
        try {
          let currentStageName = null;
          if (person.pipeline_stage_id) {
            const curRes = await db.query(
              `SELECT name FROM pipeline_stages
                WHERE id = $1 AND organizer_id = $2 LIMIT 1`,
              [person.pipeline_stage_id, recipient.organizer_id]
            );
            currentStageName = curRes.rows[0] ? curRes.rows[0].name : null;
          }

          const shouldAutoMove =
            !person.pipeline_stage_id ||
            currentStageName === 'New' ||
            currentStageName === 'Contacted';

          if (shouldAutoMove) {
            const intRes = await db.query(
              `SELECT id FROM pipeline_stages
                WHERE organizer_id = $1 AND name = 'Interested' LIMIT 1`,
              [recipient.organizer_id]
            );
            if (intRes.rows.length > 0) {
              const interestedId = intRes.rows[0].id;
              await db.query(
                `UPDATE persons
                    SET pipeline_stage_id = $1, pipeline_entered_at = NOW()
                  WHERE id = $2 AND organizer_id = $3`,
                [interestedId, person.id, recipient.organizer_id]
              );
              await db.query(
                `INSERT INTO contact_activities
                   (organizer_id, person_id, activity_type, description, meta)
                 VALUES ($1, $2, 'status_change', 'Auto-moved to Interested (reply received)', $3)`,
                [
                  recipient.organizer_id,
                  person.id,
                  JSON.stringify({
                    from_stage: currentStageName,
                    to_stage: 'Interested',
                    auto: true,
                    reason: 'reply_received',
                  }),
                ]
              );
              console.log(`  ➡️ Auto-staged ${recipient.email} to Interested`);
            }
          }
        } catch (stageErr) {
          console.warn('  ⚠️ Auto-stage failed:', stageErr.message);
        }
      }
    } catch (activityErr) {
      console.warn('  ⚠️ contact_activities insert failed:', activityErr.message);
    }

    // 6a. Sequence hook: stop sequence for replied recipient (best-effort)
    try {
      if (sequenceService) await sequenceService.handleReply(recipient.email, recipient.campaign_id, recipient.organizer_id);
    } catch (seqErr) {
      console.warn('  ⚠️ Sequence reply hook failed:', seqErr.message);
    }

    // 6b. Action Engine: evaluate reply trigger (best-effort)
    try {
      if (actionEngine) {
        const aePersonRes = await db.query(
          `SELECT id FROM persons WHERE organizer_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1`,
          [recipient.organizer_id, recipient.email]
        );
        if (aePersonRes.rows.length > 0) {
          await actionEngine.evaluateForPerson(aePersonRes.rows[0].id, recipient.organizer_id, 'reply_received');
        }
      }
    } catch (aeErr) {
      console.warn('  ⚠️ Action Engine reply trigger failed:', aeErr.message);
    }

    // 6c. NO forward — salesperson already has the reply in their Gmail inbox
    // (Reply-To = salesperson's real email, so customer replies go directly to them)
    console.log(`  ✉️ Reply processed (no forward — salesperson has it via direct Reply-To)`);

    return res.status(200).send('OK');

  } catch (err) {
    console.error('❌ Inbound webhook error:', err.message, err.stack);
    return res.status(200).send('OK'); // Always 200 to prevent retries
  }
});


// ============================================================
// GMAIL FILTER SETUP INFO (Admin Endpoint)
// ============================================================

/**
 * GET /api/webhooks/gmail-filter-info
 * Returns Gmail filter setup instructions for reply detection.
 * Salesperson must set up a Gmail filter to forward replies to SendGrid Inbound Parse.
 */
router.get('/api/webhooks/gmail-filter-info', (req, res) => {
  const inboundSecret = process.env.INBOUND_WEBHOOK_SECRET;
  const parseEmail = 'parse@inbound.liffy.app';
  const inboundUrl = inboundSecret
    ? `https://api.liffy.app/api/webhooks/inbound/${inboundSecret}`
    : '(INBOUND_WEBHOOK_SECRET not configured)';

  res.json({
    title: 'Gmail Filter Setup for Reply Detection',
    steps: [
      '1. Open Gmail → Settings → Forwarding → Add forwarding address',
      `2. Enter: ${parseEmail}`,
      '3. Gmail will send a verification email to that address — ask admin to confirm',
      '4. Go to Gmail → Settings → Filters → Create new filter',
      '5. In "Has the words" field enter: LIFFY',
      '6. Click "Create filter" → Check "Forward it to" → Select: ' + parseEmail,
      '7. Also check "Never send it to Spam" and "Skip the Inbox" (optional)',
      '8. Click "Create filter"',
    ],
    technical: {
      parse_email: parseEmail,
      inbound_url: inboundUrl,
      tracking_method: 'Hidden HTML comment <!--LIFFY:c-{8hex}-r-{8hex}--> in email body',
      reply_to: 'Salesperson real email (customer replies go directly to Gmail)',
      forward_from_liffy: false,
      note: 'Liffy does NOT forward replies. Salesperson already has them via direct Reply-To.',
    },
  });
});

// Log on startup
console.log('[Reply Detection] Mode: direct Reply-To + hidden tag + Gmail filter forward');
console.log('[Reply Detection] Salesperson Gmail filter must forward to: parse@inbound.liffy.app');

// ============================================================
// UNSUBSCRIBE ENDPOINTS
// ============================================================

/**
 * GET /api/unsubscribe/:token
 * Shows unsubscribe confirmation page
 */
router.get('/api/unsubscribe/:token', async (req, res) => {
  const { token } = req.params;
  const decoded = verifyUnsubscribeToken(token);

  if (!decoded) {
    return res.status(400).send(getUnsubscribeHTML('error', null, 'Invalid or expired unsubscribe link.'));
  }

  // Check if already unsubscribed
  const existingRes = await db.query(
    `SELECT id FROM unsubscribes WHERE organizer_id = $1 AND LOWER(email) = LOWER($2)`,
    [decoded.organizerId, decoded.email]
  );

  if (existingRes.rows.length > 0) {
    return res.send(getUnsubscribeHTML('already', decoded.email));
  }

  return res.send(getUnsubscribeHTML('confirm', decoded.email, null, token));
});

/**
 * POST /api/unsubscribe/:token
 * Processes the unsubscribe request
 */
router.post('/api/unsubscribe/:token', async (req, res) => {
  const { token } = req.params;
  const decoded = verifyUnsubscribeToken(token);

  if (!decoded) {
    return res.status(400).send(getUnsubscribeHTML('error', null, 'Invalid or expired unsubscribe link.'));
  }

  try {
    // Add to unsubscribe list
    await db.query(
      `INSERT INTO unsubscribes (organizer_id, email, source, created_at)
       VALUES ($1, LOWER($2), 'user_request', NOW())
       ON CONFLICT (organizer_id, email) DO NOTHING`,
      [decoded.organizerId, decoded.email]
    );

    console.log(`🚫 User unsubscribed: ${decoded.email}`);

    return res.send(getUnsubscribeHTML('success', decoded.email));

  } catch (err) {
    console.error('Unsubscribe error:', err.message);
    return res.status(500).send(getUnsubscribeHTML('error', null, 'Something went wrong. Please try again.'));
  }
});

/**
 * Generate Unsubscribe HTML Page
 */
function getUnsubscribeHTML(status, email, errorMessage = null, token = null) {
  const baseStyles = `
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; margin: 0; padding: 40px 20px; }
    .container { max-width: 500px; margin: 0 auto; background: white; border-radius: 12px; padding: 40px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
    h1 { margin: 0 0 20px; color: #333; font-size: 24px; }
    p { color: #666; line-height: 1.6; margin: 0 0 20px; }
    .email { background: #f0f0f0; padding: 10px 20px; border-radius: 6px; display: inline-block; font-weight: 500; color: #333; margin: 10px 0; }
    .btn { display: inline-block; padding: 14px 32px; border-radius: 8px; font-size: 16px; font-weight: 500; text-decoration: none; cursor: pointer; border: none; }
    .btn-danger { background: #dc3545; color: white; }
    .btn-danger:hover { background: #c82333; }
    .success { color: #28a745; }
    .error { color: #dc3545; }
    .icon { font-size: 48px; margin-bottom: 20px; }
  `;

  if (status === 'confirm') {
    return `<!DOCTYPE html>
<html><head><title>Unsubscribe</title><style>${baseStyles}</style></head>
<body><div class="container">
  <div class="icon">📧</div>
  <h1>Unsubscribe from emails?</h1>
  <p>You are about to unsubscribe:</p>
  <div class="email">${email}</div>
  <p>You will no longer receive marketing emails from us.</p>
  <form method="POST" action="/api/unsubscribe/${token}">
    <button type="submit" class="btn btn-danger">Yes, Unsubscribe Me</button>
  </form>
</div></body></html>`;
  }

  if (status === 'success') {
    return `<!DOCTYPE html>
<html><head><title>Unsubscribed</title><style>${baseStyles}</style></head>
<body><div class="container">
  <div class="icon">✅</div>
  <h1 class="success">Successfully Unsubscribed</h1>
  <div class="email">${email}</div>
  <p>You have been removed from our mailing list and will no longer receive emails from us.</p>
</div></body></html>`;
  }

  if (status === 'already') {
    return `<!DOCTYPE html>
<html><head><title>Already Unsubscribed</title><style>${baseStyles}</style></head>
<body><div class="container">
  <div class="icon">ℹ️</div>
  <h1>Already Unsubscribed</h1>
  <div class="email">${email}</div>
  <p>This email address is already unsubscribed from our mailing list.</p>
</div></body></html>`;
  }

  // Error state
  return `<!DOCTYPE html>
<html><head><title>Error</title><style>${baseStyles}</style></head>
<body><div class="container">
  <div class="icon">❌</div>
  <h1 class="error">Error</h1>
  <p>${errorMessage || 'Something went wrong.'}</p>
</div></body></html>`;
}

// Export router and utility functions
module.exports = router;
module.exports.getUnsubscribeUrl = getUnsubscribeUrl;
module.exports.generateUnsubscribeToken = generateUnsubscribeToken;
module.exports.verifyUnsubscribeToken = verifyUnsubscribeToken;
