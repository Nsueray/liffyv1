const express = require('express');
const router = express.Router();
const db = require('../db');
const { sendEmail } = require('../mailer');
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
      break;

    case 'unsubscribe':
      await addToUnsubscribeList(recipient.organizer_id, email, 'sendgrid_unsubscribe');
      break;
  }

  // Record to canonical campaign_events table (Phase 2)
  await recordCampaignEvent(recipient, email, eventType, eventTime, event);

  // Record prospect intent for intent-bearing events (Phase 2)
  await recordProspectIntent(recipient, email, eventType, eventTime);
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
 * Extract bare email address from "Name <email>" or plain "email" format.
 */
function extractEmail(fromField) {
  if (!fromField) return null;
  const match = fromField.match(/<([^>]+)>/);
  return match ? match[1].trim() : fromField.trim();
}

/**
 * Extract display name from "Name <email>" format. Returns email if no name.
 */
function extractName(fromField) {
  if (!fromField) return null;
  const match = fromField.match(/^([^<]+)<[^>]+>/);
  return match ? match[1].trim().replace(/^"|"$/g, '') : extractEmail(fromField);
}

/**
 * Strip quoted reply history from email body.
 * Removes "On [date] ... wrote:" lines and subsequent > quoted lines.
 */
function stripQuotedHistory(text) {
  if (!text) return text;
  const lines = text.split('\n');
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // "On ... wrote:" pattern (English) — may span 2 lines
    // e.g. "On Mon, 16 Mar 2026 at 14:57, Elif AY <elif@elan-expo.com> wrote:"
    if (/^On\s.+wrote:\s*$/i.test(line)) break;
    // "On ..." first line, "wrote:" on next line
    if (/^On\s.+[^:]\s*$/i.test(line) && i + 1 < lines.length && /wrote:\s*$/i.test(lines[i + 1])) break;
    // Greek: "Στις ... έγραψε:" — may span 2 lines
    if (/^Στις\s.+έγραψε:\s*$/i.test(line)) break;
    if (/^Στις\s.+/i.test(line) && i + 1 < lines.length && /έγραψε:\s*$/i.test(lines[i + 1])) break;
    // German: "Am ... schrieb ..."
    if (/^Am\s.+schrieb\s.+:?\s*$/i.test(line)) break;
    // French: "Le ... a écrit :"
    if (/^Le\s.+a écrit\s*:?\s*$/i.test(line)) break;
    // Turkish: "tarihinde ... yazdı:"
    if (/tarihinde\s.+yazdı:\s*$/i.test(line)) break;
    // Generic: line starts with ">" (quoted text)
    if (/^\s*>/.test(line)) break;
    // "---------- Forwarded message ----------" or similar separators
    if (/^-{5,}\s*(Forwarded|Original)\s/i.test(line)) break;
    // "From: ... Sent: ..." Outlook-style quote header
    if (/^From:\s.+/i.test(line) && i > 0 && lines[i - 1].trim() === '') {
      // Check if next lines look like Outlook headers (Sent:, To:, Subject:)
      if (i + 1 < lines.length && /^(Sent|To|Date|Subject):\s/i.test(lines[i + 1])) break;
    }

    result.push(line);
  }

  // Trim trailing empty lines
  while (result.length > 0 && result[result.length - 1].trim() === '') {
    result.pop();
  }

  return result.length > 0 ? result.join('\n') : text;
}

/**
 * Build HTML body for the reply forward wrapper email.
 * Clean, minimal — just metadata header + reply content.
 */
function buildReplyForwardHtml({ senderEmail, senderName, campaignName, replyBody, replyTime }) {
  const escapedBody = (replyBody || '(no content)')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  return `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <div style="font-size: 13px; color: #64748b; margin-bottom: 16px;">
    <strong>From:</strong> ${senderName || senderEmail} &lt;${senderEmail}&gt;<br>
    <strong>Campaign:</strong> ${campaignName || '(unknown)'}<br>
    <strong>Date:</strong> ${replyTime.toISOString().replace('T', ' ').substring(0, 19)} UTC
  </div>

  <div style="font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;">
${escapedBody}
  </div>
</div>`;
}

/**
 * Forward reply to the organizer's real inbox as a wrapper email.
 * Uses the campaign's sender_identity to determine the forward target.
 * Never throws — all errors are caught and logged.
 *
 * Mail loop prevention:
 * - Wrapper is sent FROM notify@liffy.app (or FORWARD_FROM_EMAIL env var) — no VERP match possible
 * - Auto-reply to notify@liffy.app will not match any VERP pattern
 * - Even if it somehow arrives at /inbound, parseVerpAddress() returns null → skipped
 *
 * Multi-tenant safety:
 * - Forward target derived from campaign → sender_identity (organizer-scoped)
 * - SendGrid API key from the organizer's own account
 */
async function forwardReplyToOrganizer({ campaignId, from, subject, text, replyTime }) {
  try {
    // Lookup campaign → sender_identity → organizer in one query
    const res = await db.query(
      `SELECT c.name as campaign_name,
              s.reply_to, s.from_email, s.from_name,
              o.sendgrid_api_key
       FROM campaigns c
       JOIN sender_identities s ON c.sender_id = s.id
       JOIN organizers o ON c.organizer_id = o.id
       WHERE c.id = $1`,
      [campaignId]
    );

    if (res.rows.length === 0) {
      console.log(`  ⚠️ Forward: campaign/sender not found for ${campaignId} — skipping`);
      return;
    }

    const { campaign_name, reply_to, from_email, sendgrid_api_key } = res.rows[0];
    const forwardTo = reply_to || from_email;

    if (!forwardTo) {
      console.log(`  ⚠️ Forward: no forward target (reply_to and from_email both null) — skipping`);
      return;
    }

    if (!sendgrid_api_key) {
      console.log(`  ⚠️ Forward: no SendGrid API key for organizer — skipping`);
      return;
    }

    const senderEmail = extractEmail(from);
    const senderName = extractName(from);
    const replyBody = stripQuotedHistory(text) || null;

    const forwardSubject = `Re: ${subject || '(no subject)'}`;

    // Display name: "Reply: Raffaella Presciani" — clear indicator this is a forwarded reply
    const displayName = senderName && senderName !== senderEmail
      ? `Reply: ${senderName}`
      : `Reply: ${senderEmail}`;

    const forwardHtml = buildReplyForwardHtml({
      senderEmail,
      senderName,
      campaignName: campaign_name,
      replyBody,
      replyTime,
    });

    const forwardText = [
      `From: ${senderName || senderEmail} <${senderEmail}>`,
      `Campaign: ${campaign_name || '(unknown)'}`,
      `Date: ${replyTime.toISOString().replace('T', ' ').substring(0, 19)} UTC`,
      ``,
      replyBody || '(no content)',
    ].join('\n');

    const result = await sendEmail({
      to: forwardTo,
      subject: forwardSubject,
      html: forwardHtml,
      text: forwardText,
      from_email: process.env.FORWARD_FROM_EMAIL || 'notify@liffy.app',
      from_name: displayName,
      reply_to: senderEmail, // Organizer can hit Reply to respond directly
      sendgrid_api_key: sendgrid_api_key,
    });

    if (result && result.success) {
      console.log(`  📤 Reply forwarded to ${forwardTo} (from: ${senderEmail})`);
    } else {
      console.log(`  ⚠️ Forward failed to ${forwardTo}: ${result?.error || 'unknown error'}`);
    }
  } catch (err) {
    // Never break the inbound webhook flow
    console.error(`  ❌ Forward error for campaign ${campaignId}:`, err.message);
  }
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
 * 2. Extract VERP from envelope.to or to field
 * 3. Filter auto-replies
 * 4. Look up campaign_recipient by VERP (campaign_id + recipient_id)
 * 5. Record reply as campaign_event (event_type='reply')
 * 6. Record prospect_intent (intent_type='reply')
 * 7. Forward reply to organizer's inbox (wrapper email)
 * 8. Do NOT update campaign_recipients.status
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

    // Envelope domain validation — only accept emails to @reply.liffy.app
    const envelope = typeof req.body.envelope === 'string'
      ? JSON.parse(req.body.envelope || '{}')
      : req.body.envelope || {};

    const toAddresses = Array.isArray(envelope?.to)
      ? envelope.to
      : [envelope?.to].filter(Boolean);

    const validDomain = toAddresses.some(addr =>
      typeof addr === 'string' &&
      addr.toLowerCase().endsWith('@reply.liffy.app')
    );

    if (!validDomain) {
      console.warn('⚠️ Inbound webhook: invalid envelope domain');
      return res.status(200).send('OK');
    }

    const { from, to, subject, text, headers } = req.body;

    console.log(`📨 Inbound email received — from: ${from}, to: ${to}, subject: ${subject}`);

    // 1. Extract VERP address from envelope (preferred) or to field
    let verpAddress = null;
    for (const addr of toAddresses) {
      const parsed = parseVerpAddress(addr);
      if (parsed) {
        verpAddress = parsed;
        break;
      }
    }

    // Fallback: try the to field directly
    if (!verpAddress && to) {
      // to field may contain "Name <email>" or just "email", possibly comma-separated
      const toFallback = to.split(',').map(a => a.trim());
      for (const addr of toFallback) {
        const emailMatch = addr.match(/<([^>]+)>/) || [null, addr];
        const parsed = parseVerpAddress(emailMatch[1]);
        if (parsed) {
          verpAddress = parsed;
          break;
        }
      }
    }

    if (!verpAddress) {
      console.log('  ⚠️ No VERP address found in inbound email — skipping');
      return res.status(200).send('OK');
    }

    console.log(`  🔗 VERP parsed — campaign: ${verpAddress.campaignShort}, recipient: ${verpAddress.recipientShort}`);

    // 2. Filter auto-replies
    if (isAutoReply({ subject, headers, from })) {
      console.log(`  🤖 Auto-reply detected — skipping (subject: "${subject}", from: ${from})`);
      return res.status(200).send('OK');
    }

    // 3. Look up campaign_recipient by VERP (short prefix match, LIMIT 2 for collision detection)
    const recipientRes = await db.query(
      `SELECT cr.id, cr.campaign_id, cr.organizer_id, cr.email, cr.status
       FROM campaign_recipients cr
       WHERE LEFT(cr.campaign_id::text, 8) = $1
         AND LEFT(cr.id::text, 8) = $2
       LIMIT 2`,
      [verpAddress.campaignShort, verpAddress.recipientShort]
    );

    if (recipientRes.rows.length === 0) {
      console.log(`  ⚠️ No recipient found for VERP — campaign: ${verpAddress.campaignShort}, recipient: ${verpAddress.recipientShort}`);
      return res.status(200).send('OK');
    }

    // Collision guard: if short prefix matches more than one row, refuse to process
    if (recipientRes.rows.length > 1) {
      console.error(`  ❌ VERP collision detected — short IDs not unique: campaignShort=${verpAddress.campaignShort}, recipientShort=${verpAddress.recipientShort}, matches=${recipientRes.rows.length}`);
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
      text: text ? text.substring(0, 500) : null, // Truncate body for storage
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

    // 6. Forward reply to organizer's inbox (best-effort, never blocks response)
    await forwardReplyToOrganizer({
      campaignId: recipient.campaign_id,
      from,
      subject,
      text,
      replyTime,
    });

    return res.status(200).send('OK');

  } catch (err) {
    console.error('❌ Inbound webhook error:', err.message, err.stack);
    return res.status(200).send('OK'); // Always 200 to prevent retries
  }
});


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
