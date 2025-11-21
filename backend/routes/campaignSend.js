const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');
const { sendEmail } = require('../mailer');

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

/**
 * Middleware: validate JWT and attach req.auth
 */
function authRequired(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "Missing Authorization header" });
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const payload = jwt.verify(token, JWT_SECRET);

    req.auth = {
      user_id: payload.user_id,
      organizer_id: payload.organizer_id,
      role: payload.role
    };
    next();
  } catch (err) {
    console.error("Auth error:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * POST /api/campaigns/:id/send-batch
 * Send a batch of pending recipients for a campaign.
 *
 * Body:
 * {
 *   "sender_identity_id": "...",
 *   "batch_size": 10   // optional
 * }
 */
router.post('/api/campaigns/:id/send-batch', authRequired, async (req, res) => {
  const client = await db.connect();

  try {
    const campaign_id = req.params.id;
    const organizer_id = req.auth.organizer_id;
    const { sender_identity_id, batch_size } = req.body;

    const limit = parseInt(batch_size, 10) || 10;
    if (!sender_identity_id) {
      return res.status(400).json({ error: "sender_identity_id is required" });
    }

    // 1) Load campaign
    const campRes = await client.query(
      `SELECT c.*, t.subject, t.body_html, t.body_text
       FROM campaigns c
       JOIN email_templates t ON c.template_id = t.id
       WHERE c.id = $1 AND c.organizer_id = $2`,
      [campaign_id, organizer_id]
    );

    if (campRes.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const campaign = campRes.rows[0];

    // 2) Load organizer
    const orgRes = await client.query(
      `SELECT * FROM organizers WHERE id = $1`,
      [organizer_id]
    );
    if (orgRes.rows.length === 0) {
      return res.status(404).json({ error: "Organizer not found" });
    }
    const organizer = orgRes.rows[0];

    // 3) Load sender identity
    const senderRes = await client.query(
      `SELECT * FROM sender_identities
       WHERE id = $1 AND organizer_id = $2 AND is_active = true`,
      [sender_identity_id, organizer_id]
    );
    if (senderRes.rows.length === 0) {
      return res.status(400).json({ error: "Sender identity not found or inactive" });
    }
    const sender = senderRes.rows[0];

    // 4) Load pending recipients
    const recRes = await client.query(
      `SELECT * FROM campaign_recipients
       WHERE campaign_id = $1 AND organizer_id = $2 AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT $3`,
      [campaign_id, organizer_id, limit]
    );

    const recipients = recRes.rows;
    if (recipients.length === 0) {
      return res.json({ success: true, message: "No pending recipients", sent: 0, failed: 0 });
    }

    let sentCount = 0;
    let failCount = 0;

    for (const r of recipients) {
      try {
        const mailResp = await sendEmail({
          to: r.email,
          subject: campaign.subject,
          text: campaign.body_text || '',
          html: campaign.body_html,
          from_name: sender.from_name,
          from_email: sender.from_email,
          reply_to: sender.reply_to || null,
          sendgrid_api_key: organizer.sendgrid_api_key
        });

        if (mailResp && mailResp.success) {
          sentCount += 1;

          // mark recipient as sent
          await client.query(
            `UPDATE campaign_recipients
             SET status = 'sent', last_error = NULL
             WHERE id = $1`,
            [r.id]
          );

          // insert log
          await client.query(
            `INSERT INTO email_logs
             (organizer_id, campaign_id, template_id, recipient_email, recipient_data, status, provider_response, sent_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
            [
              organizer_id,
              campaign_id,
              campaign.template_id,
              r.email,
              r.meta,
              'sent',
              mailResp
            ]
          );
        } else {
          failCount += 1;
          await client.query(
            `UPDATE campaign_recipients
             SET status = 'failed', last_error = $2
             WHERE id = $1`,
            [r.id, mailResp && mailResp.error ? mailResp.error : 'Unknown error']
          );
        }
      } catch (e) {
        console.error("Send error for recipient", r.email, e.message);
        failCount += 1;
        await client.query(
          `UPDATE campaign_recipients
           SET status = 'failed', last_error = $2
           WHERE id = $1`,
          [r.id, e.message]
        );
      }
    }

    return res.json({
      success: true,
      message: `Batch processed`,
      total: recipients.length,
      sent: sentCount,
      failed: failCount
    });

  } catch (err) {
    console.error("send-batch error:", err);
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
