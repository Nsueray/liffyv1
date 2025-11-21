const express = require('express');
const router = express.Router();
const db = require('../db');
const { sendEmail } = require('../mailer');

router.post('/api/test-email', async (req, res) => {
  try {
    const { recipient_email, template_id, organizer_id } = req.body;

    if (!recipient_email || !template_id || !organizer_id) {
      return res.status(400).json({ error: "recipient_email, template_id and organizer_id required" });
    }

    // Template çek
    const result = await db.query(
      "SELECT * FROM email_templates WHERE id = $1 AND organizer_id = $2",
      [template_id, organizer_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Template not found" });
    }

    const template = result.rows[0];

    // Mail gönder
    const mailResponse = await sendEmail({
      to: recipient_email,
      subject: template.subject,
      text: template.body_text || "",
      html: template.body_html
    });

    // Log kaydet
    await db.query(
      `INSERT INTO email_logs (organizer_id, campaign_id, template_id, recipient_email, status, provider_response)
       VALUES ($1, NULL, $2, $3, $4, $5)`,
      [organizer_id, template_id, recipient_email, "sent", mailResponse]
    );

    res.json({ success: true, message: "Mail sent!", mailResponse });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
