const express = require('express');
const router = express.Router();
const db = require('../db');

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
         WHERE id = $1 AND status = 'sent'`,
        [recipient.id, eventTime]
      );
      break;

    case 'open':
      await db.query(
        `UPDATE campaign_recipients
         SET status = 'opened',
             opened_at = COALESCE(opened_at, $2),
             open_count = COALESCE(open_count, 0) + 1
         WHERE id = $1`,
        [recipient.id, eventTime]
      );
      break;

    case 'click':
      await db.query(
        `UPDATE campaign_recipients
         SET status = 'clicked',
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
