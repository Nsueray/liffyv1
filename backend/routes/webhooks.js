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

// Signature parser for reply enrichment (best-effort)
const { parseEmailSignature, enrichPersonFromSignature } = require('../utils/signatureParser');

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
    // Use pre-resolved person_id if available (inbound handler sets it),
    // otherwise do best-effort lookup from canonical persons table
    let personId = recipient.person_id || null;
    if (!personId) {
      const personRes = await db.query(
        `SELECT id FROM persons WHERE organizer_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1`,
        [recipient.organizer_id, email]
      );
      if (personRes.rows.length > 0) {
        personId = personRes.rows[0].id;
      }
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
 * Parse plus-addressed email for campaign/recipient IDs.
 * Format: local+c-{8hex}-r-{8hex}@domain.com
 * Gmail ignores the +tag, so elif+c-abc12345-r-def67890@elan-expo.com → elif@elan-expo.com
 *
 * @param {string} address - Email address (may be "Name <email>" format)
 * @returns {object|null} - { campaignShort, recipientShort } or null
 */
function parsePlusAddress(address) {
  if (!address || typeof address !== 'string') return null;
  // Handle comma-separated addresses and "Name <email>" format
  const addresses = address.split(',');
  for (const addr of addresses) {
    const emailMatch = addr.match(/<([^>]+)>/) || [null, addr.trim()];
    const email = (emailMatch[1] || '').trim();
    const match = email.match(/\+c-([a-f0-9]{8})-r-([a-f0-9]{8})@/i);
    if (match) {
      return { campaignShort: match[1].toLowerCase(), recipientShort: match[2].toLowerCase() };
    }
  }
  return null;
}

/**
 * Detect reply source from an inbound email.
 * Tries multiple methods in order of reliability:
 *
 * Method 0: Plus addressing in To header (most reliable — present in envelope/header)
 * Method 1: Unsubscribe link token in quoted body (full UUIDs, if body preserved)
 * Method 2: From-email matching against campaign_recipients (fallback)
 *
 * @param {string} body - Email body (HTML or text)
 * @param {string} fromEmail - Sender email address
 * @param {string} toAddress - To header (may contain plus-addressed email)
 * @returns {object|null} - { email, organizerId, campaignId, recipientId } or null
 */
async function detectReplySource(body, fromEmail, toAddress) {
  // Method 0: Plus addressing in To header (e.g. elif+c-abc12345-r-def67890@elan-expo.com)
  const plusIds = parsePlusAddress(toAddress);
  if (plusIds) {
    try {
      // Look up campaign_recipient by short prefix match
      const crRes = await db.query(
        `SELECT cr.id, cr.campaign_id, cr.organizer_id, cr.email
         FROM campaign_recipients cr
         WHERE LEFT(cr.campaign_id::text, 8) = $1
           AND LEFT(cr.id::text, 8) = $2
         LIMIT 1`,
        [plusIds.campaignShort, plusIds.recipientShort]
      );
      if (crRes.rows.length > 0) {
        const row = crRes.rows[0];
        console.log(`[Inbound] Reply matched via plus addressing — campaign: ${row.campaign_id}`);
        return {
          email: row.email,
          organizerId: row.organizer_id,
          campaignId: row.campaign_id,
          recipientId: row.id
        };
      }

      // Try sequence_recipients if not found in campaign_recipients
      const srRes = await db.query(
        `SELECT sr.id, sr.campaign_id, sr.organizer_id, sr.email
         FROM sequence_recipients sr
         WHERE LEFT(sr.campaign_id::text, 8) = $1
           AND LEFT(sr.id::text, 8) = $2
         LIMIT 1`,
        [plusIds.campaignShort, plusIds.recipientShort]
      );
      if (srRes.rows.length > 0) {
        const row = srRes.rows[0];
        console.log(`[Inbound] Reply matched via plus addressing (sequence) — campaign: ${row.campaign_id}`);
        // Find matching campaign_recipient by email for event recording
        const crFallback = await db.query(
          `SELECT id FROM campaign_recipients
           WHERE campaign_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1`,
          [row.campaign_id, row.email]
        );
        return {
          email: row.email,
          organizerId: row.organizer_id,
          campaignId: row.campaign_id,
          recipientId: crFallback.rows.length > 0 ? crFallback.rows[0].id : row.id
        };
      }

      console.log(`[Inbound] Plus addressing found but no recipient match — campaign=${plusIds.campaignShort}, recipient=${plusIds.recipientShort}`);
    } catch (e) {
      console.warn('[Inbound] Plus addressing lookup failed:', e.message);
    }
  }

  // Method 1: Unsubscribe link token in quoted body (full UUIDs)
  const unsubMatch = (body || '').match(/api\.liffy\.app\/api\/unsubscribe\/([A-Za-z0-9_\-+\/=]+)/);
  if (unsubMatch) {
    try {
      const decoded = verifyUnsubscribeToken(unsubMatch[1]);
      if (decoded && decoded.campaignId && decoded.recipientId) {
        console.log('[Inbound] Reply matched via unsubscribe link — campaign:', decoded.campaignId);
        return decoded;
      }
      // Old format token (email:orgId only) — no campaign info, fall through to Method 2
      if (decoded) {
        console.log('[Inbound] Old unsubscribe format — falling back to email match');
      }
    } catch (e) { /* ignore parse errors */ }
  }

  // Method 2: From email matching (fallback — matches most recent campaign recipient)
  if (fromEmail) {
    // Extract bare email from "Name <email>" format
    const emailMatch = fromEmail.match(/<([^>]+)>/) || [null, fromEmail];
    const bareEmail = (emailMatch[1] || '').trim();
    if (bareEmail) {
      try {
        const result = await db.query(`
          SELECT cr.campaign_id, cr.person_id, cr.id as recipient_id, c.organizer_id, cr.email
          FROM campaign_recipients cr
          JOIN campaigns c ON c.id = cr.campaign_id
          WHERE LOWER(cr.email) = LOWER($1)
            AND cr.status IN ('sent', 'delivered', 'opened', 'clicked')
          ORDER BY cr.sent_at DESC NULLS LAST
          LIMIT 1
        `, [bareEmail]);
        if (result.rows.length > 0) {
          const row = result.rows[0];
          console.log('[Inbound] Reply matched via email — campaign:', row.campaign_id);
          return {
            email: row.email,
            organizerId: row.organizer_id,
            campaignId: row.campaign_id,
            recipientId: row.recipient_id
          };
        }
      } catch (e) {
        console.warn('[Inbound] Email match query failed:', e.message);
      }
    }
  }

  return null;
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
 * 2. Filter auto-replies
 * 3. Detect reply source: plus addressing in To (primary), unsubscribe URL token (secondary), from-email match (fallback)
 * 4. Record reply as campaign_event (event_type='reply')
 * 5. Record prospect_intent (intent_type='reply')
 * 6. Update status, contact_activities, pipeline auto-stage
 * 7. NO forward — salesperson already has the reply in their inbox (Reply-To = their email)
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

    // 1. Filter auto-replies first (cheap check, avoids DB queries)
    if (isAutoReply({ subject, headers, from })) {
      console.log(`  🤖 Auto-reply detected — skipping (subject: "${subject}", from: ${from})`);
      return res.status(200).send('OK');
    }

    // 2a. Test reply detection (c-00000000-r-00000000 pattern)
    const testPlusIds = parsePlusAddress(to);
    if (testPlusIds && testPlusIds.campaignShort === '00000000' && testPlusIds.recipientShort === '00000000') {
      console.log(`[Inbound] Test reply detected — from: ${from}, to: ${to}`);
      // Find organizer from the To address (user's plus-addressed email)
      // To: suer+c-00000000-r-00000000@elan-expo.com → base email: suer@elan-expo.com
      let orgId = null;
      const toAddresses = (to || '').split(',');
      for (const addr of toAddresses) {
        const emailMatch = addr.match(/<([^>]+)>/) || [null, addr.trim()];
        const email = (emailMatch[1] || '').trim();
        // Strip plus-address part to get base email
        const baseEmail = email.replace(/\+[^@]*@/, '@');
        if (baseEmail && baseEmail.includes('@')) {
          const orgLookup = await db.query(
            `SELECT organizer_id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
            [baseEmail]
          );
          if (orgLookup.rows.length > 0) {
            orgId = orgLookup.rows[0].organizer_id;
            break;
          }
        }
      }
      if (orgId) {
        global._liffyTestReplies = global._liffyTestReplies || {};
        global._liffyTestReplies[orgId] = new Date().toISOString();
        console.log(`[Inbound] Test reply recorded in memory for organizer ${orgId}`);
      } else {
        console.warn(`[Inbound] Test reply — could not resolve organizer from to: ${to}`);
      }
      return res.status(200).send('OK');
    }

    // 2b. Detect reply source — plus addressing (primary), unsubscribe link, or from-email match
    const replySource = await detectReplySource(html || text || '', from, to);

    if (!replySource) {
      console.log('  ⚠️ No reply source detected (no unsubscribe link, no email match) — skipping');
      return res.status(200).send('OK');
    }

    // 3. Look up campaign_recipient by full IDs
    const recipientRes = await db.query(
      `SELECT cr.id, cr.campaign_id, cr.organizer_id, cr.email, cr.status
       FROM campaign_recipients cr
       WHERE cr.campaign_id = $1 AND cr.id = $2
       LIMIT 1`,
      [replySource.campaignId, replySource.recipientId]
    );

    if (recipientRes.rows.length === 0) {
      console.log(`  ⚠️ No recipient found — campaign=${replySource.campaignId}, recipient=${replySource.recipientId}`);
      return res.status(200).send('OK');
    }

    const recipient = recipientRes.rows[0];
    const replyTime = new Date();

    console.log(`  ✅ Reply matched — ${recipient.email} → campaign ${recipient.campaign_id}`);

    // 3a. Resolve person_id ONCE — used by all downstream operations
    // (campaign_events, prospect_intents, contact_activities, Action Engine)
    let personId = null;
    let personPipelineStageId = null;
    try {
      const personRes = await db.query(
        `SELECT id, pipeline_stage_id FROM persons
          WHERE organizer_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1`,
        [recipient.organizer_id, recipient.email]
      );
      if (personRes.rows.length > 0) {
        personId = personRes.rows[0].id;
        personPipelineStageId = personRes.rows[0].pipeline_stage_id;
      }
    } catch (personErr) {
      console.warn(`  ⚠️ Person lookup failed for ${recipient.email}:`, personErr.message);
    }

    if (!personId) {
      console.warn(`  ⚠️ No person found for ${recipient.email} (organizer: ${recipient.organizer_id}) — some features may not trigger`);
    }

    // Attach person_id to recipient object so recordCampaignEvent can use it
    recipient.person_id = personId;

    // 4. Record reply as campaign_event (with person_id)
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

    console.log(`  📝 Reply recorded for ${recipient.email} (campaign: ${recipient.campaign_id}, person: ${personId || 'NULL'})`);

    // Best-effort contact_activities + pipeline auto-stage (requires person_id)
    if (personId) {
      try {
        await db.query(
          `INSERT INTO contact_activities
             (organizer_id, person_id, activity_type, description, meta, occurred_at)
           VALUES ($1, $2, 'email_replied', $3, $4, $5)`,
          [
            recipient.organizer_id,
            personId,
            (subject || '').substring(0, 200),
            JSON.stringify({ campaign_id: recipient.campaign_id, from, subject }),
            replyTime,
          ]
        );

        // Auto-stage: if person is unassigned, New, or Contacted → move to Interested
        try {
          let currentStageName = null;
          if (personPipelineStageId) {
            const curRes = await db.query(
              `SELECT name FROM pipeline_stages
                WHERE id = $1 AND organizer_id = $2 LIMIT 1`,
              [personPipelineStageId, recipient.organizer_id]
            );
            currentStageName = curRes.rows[0] ? curRes.rows[0].name : null;
          }

          const shouldAutoMove =
            !personPipelineStageId ||
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
                [interestedId, personId, recipient.organizer_id]
              );
              await db.query(
                `INSERT INTO contact_activities
                   (organizer_id, person_id, activity_type, description, meta)
                 VALUES ($1, $2, 'status_change', 'Auto-moved to Interested (reply received)', $3)`,
                [
                  recipient.organizer_id,
                  personId,
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
      } catch (activityErr) {
        console.warn('  ⚠️ contact_activities insert failed:', activityErr.message);
      }
    }

    // 6a. Sequence hook: stop sequence for replied recipient (best-effort)
    try {
      if (sequenceService) await sequenceService.handleReply(recipient.email, recipient.campaign_id, recipient.organizer_id);
    } catch (seqErr) {
      console.warn('  ⚠️ Sequence reply hook failed:', seqErr.message);
    }

    // 6b. Action Engine: evaluate reply trigger (best-effort)
    if (personId) {
      try {
        if (actionEngine) {
          console.log(`  🎯 Action Engine: evaluating reply_received for person ${personId}`);
          await actionEngine.evaluateForPerson(personId, recipient.organizer_id, 'reply_received');
          console.log(`  ✅ Action Engine: reply_received trigger evaluated`);
        } else {
          console.warn('  ⚠️ Action Engine module not loaded — reply_received trigger skipped');
        }
      } catch (aeErr) {
        console.warn('  ⚠️ Action Engine reply trigger failed:', aeErr.message);
      }
    } else {
      console.warn(`  ⚠️ Action Engine skipped — no person_id for ${recipient.email}`);
    }

    // 6c. Signature enrichment — parse reply body for phone, title, company (best-effort)
    if (personId) {
      try {
        const signatureData = parseEmailSignature(text || html || '');
        if (signatureData) {
          await enrichPersonFromSignature(personId, recipient.organizer_id, signatureData);
        }
      } catch (sigErr) {
        console.warn('  ⚠️ Signature enrichment failed:', sigErr.message);
      }
    }

    // 6d. NO forward — salesperson already has the reply in their Gmail inbox
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
 *
 * Reply detection uses plus addressing: Reply-To = elif+c-{8hex}-r-{8hex}@elan-expo.com
 * Gmail filter matches "deliveredto:(+c-)" to catch all plus-addressed replies.
 */
router.get('/api/webhooks/gmail-filter-info', (req, res) => {
  const inboundSecret = process.env.INBOUND_WEBHOOK_SECRET;
  const parseEmail = 'parse@inbound.liffy.app';
  const inboundUrl = inboundSecret
    ? `https://api.liffy.app/api/webhooks/inbound/${inboundSecret}`
    : '(INBOUND_WEBHOOK_SECRET not configured)';

  res.json({
    title: 'Gmail Filter Setup for Reply Detection (Plus Addressing)',
    steps: [
      '1. Open Gmail → Settings → Forwarding → Add forwarding address',
      `2. Enter: ${parseEmail}`,
      '3. Gmail will send a verification email to that address — ask admin to confirm',
      '4. Go to Gmail → Settings → Filters → Create new filter',
      '5. In "Has the words" field enter: deliveredto:(+c-)',
      '6. Click "Create filter" → Check "Forward it to" → Select: ' + parseEmail,
      '7. Also check "Never send it to Spam" and keep "Skip the Inbox" UNCHECKED (keep in inbox)',
      '8. Click "Create filter"',
    ],
    alternative_workspace: {
      description: 'For Google Workspace admins — Content Compliance rule',
      steps: [
        '1. Admin Console → Apps → Google Workspace → Gmail → Compliance → Content Compliance',
        '2. Add rule: Inbound messages',
        '3. Expression: envelope recipient matches \\+c-[a-f0-9]{8}-r-[a-f0-9]{8}@',
        `4. Action: Also deliver to ${parseEmail}`,
      ],
    },
    technical: {
      parse_email: parseEmail,
      inbound_url: inboundUrl,
      tracking_method: 'Plus addressing in Reply-To (e.g. elif+c-abc12345-r-def67890@elan-expo.com)',
      fallback_methods: [
        'Unsubscribe URL token in quoted body (contains campaign_id + recipient_id)',
        'From-email matching against campaign_recipients (most recent sent)',
      ],
      reply_to: 'Salesperson email with plus tag (customer sees normal email thread)',
      forward_from_liffy: false,
      note: 'Liffy does NOT forward replies. Salesperson already has them via direct Reply-To. Gmail ignores the +tag — email delivers to the salesperson inbox normally.',
    },
  });
});

// Log on startup
console.log('[Reply Detection] Mode: plus addressing Reply-To + Gmail filter forward');
console.log('[Reply Detection] Reply-To format: user+c-{8hex}-r-{8hex}@domain.com');
console.log('[Reply Detection] Gmail filter: "Has the words" = deliveredto:(+c-)');
console.log('[Reply Detection] Forward to: parse@inbound.liffy.app');

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
