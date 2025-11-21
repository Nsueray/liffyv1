const express = require('express');
const router = express.Router();
const db = require('../db');
const { sendEmail } = require('../mailer');

/**
 * POST /api/test-email
 * Body:
 * {
 *   "recipient_email": "someone@example.com",
 *   "template_id": "uuid",
 *   "organizer_id": "uuid",
 *   "sender_identity_id": "uuid"  // optional, if missing will use default sender
 * }
 */
router.post('/api/test-email', async (req, res) => {
  try {
    const {
      recipient_email,
      template_id,
      organizer_id,
      sender_identity_id
    } = req.body;

    if (!recipient_email || !template_id || !organizer_id) {
      return res.status(400).json({
        error: "recipient_email, template_id and organizer_id are required"
      });
    }

    // 1) Get template (must belong to this organizer)
    const templateResult = await db.query(
      `SELECT * FROM email_templates 
       WHERE id = $1 AND organizer_id = $2`,
      [template_id, organizer_id]
    );

    if (templateResult.rows.length === 0) {
      return res.status(404).json({ error: "Template not found" });
    }

    const template = templateResult.rows[0];

    // 2) Get organizer (for SendGrid API key and defaults)
    const orgResult = await db.query(
      `SELECT id, name, sendgrid_api_key, default_from_email, default_from_name
       FROM organizers
       WHERE id = $1`,
      [organizer_id]
    );

    if (orgResult.rows.length === 0) {
      return res.status(404).json({ error: "Organizer not found" });
    }

    const organizer = orgResult.rows[0];

    if (!organizer.sendgrid_api_key) {
      return res.status(400).json({ error: "Organizer is missing SendGrid API key" });
    }

    // 3) Get sender identity
    let sender = null;

    if (sender_identity_id) {
      const senderResult = await db.query(
        `SELECT * FROM sender_identities
         WHERE id = $1 AND organizer_id = $2 AND is_active = true`,
        [sender_identity_id, organizer_id]
      );

      if (senderResult.rows.length === 0) {
        return res.status(404).json({ error: "Sender identity not found" });
      }

      sender = senderResult.rows[0];
    } else {
      // If no sender_identity_id provided, try default sender
      const senderResult = await db.query(
        `SELECT * FROM sender_identities
         WHERE organizer_id = $1 AND is_active = true AND is_default = true
         ORDER BY created_at ASC
         LIMIT 1`,
        [organizer_id]
      );

      if (senderResult.rows.length > 0) {
        sender = senderResult.rows[0];
      }
    }

    // Fallback if no sender identity at all: use organizer defaults
    const fromEmail = sender ? sender.from_email : organizer.default_from_email;
    const fromName = sender ? sender.from_name : organizer.default_from_name;
    const replyTo = sender && sender.reply_to ? sender.reply_to : null;

    if (!fromEmail || !fromName) {
      return res.status(400).json({
        error: "No valid sender identity or organizer defaults configured"
      });
    }

    // 4) Send email
    const mailResponse = await sendEmail({
      to: recipient_email,
      subject: template.subject,
      text: template.body_text || "",
      html: template.body_html,
      fromEmail,
      fromName,
      replyTo,
      sendgridApiKey: organizer.sendgrid_api_key
    });

    // 5) Insert into email_logs
    const status = mailResponse.success ? 'sent' : 'failed';

    await db.query(
      `INSERT INTO email_logs 
       (organizer_id, campaign_id, template_id, recipient_email, recipient_data, status, provider_response, sent_at)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, NOW())`,
      [
        organizer_id,
        template_id,
        recipient_email,
        sender ? { sender_identity_id: sender.id } : null,
        status,
        mailResponse
      ]
    );

    return res.json({
      success: mailResponse.success,
      message: mailResponse.success ? "Mail sent!" : "Mail failed",
      mailResponse
    });

  } catch (err) {
    console.error("POST /api/test-email error:", err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
