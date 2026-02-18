const express = require('express');
const router = express.Router();
const pool = require('../db');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

function authRequired(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization token required' });
  }

  const token = authHeader.replace('Bearer ', '');
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.auth = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// GET /api/email-templates
router.get('/', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const result = await pool.query(
      `SELECT id, name, subject, body_html, body_text, created_at
       FROM email_templates
       WHERE organizer_id = $1
       ORDER BY created_at DESC`,
      [organizerId]
    );

    res.json({ templates: result.rows });
  } catch (error) {
    console.error('Error fetching email templates:', error);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

// POST /api/email-templates
router.post('/', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const { name, subject, body_html, body_text } = req.body;

    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!subject || !subject.trim()) return res.status(400).json({ error: 'Subject is required' });
    if (!body_html || !body_html.trim()) return res.status(400).json({ error: 'Body HTML is required' });

    const result = await pool.query(
      `INSERT INTO email_templates
       (organizer_id, name, subject, body_html, body_text, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id, name, subject, body_html, body_text, created_at`,
      [organizerId, name.trim(), subject.trim(), body_html, body_text || null]
    );

    res.status(201).json({ template: result.rows[0] });
  } catch (error) {
    console.error('Error creating email template:', error);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

// GET /api/email-templates/:id
router.get('/:id', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const templateId = req.params.id;

    const result = await pool.query(
      `SELECT id, name, subject, body_html, body_text, created_at
       FROM email_templates
       WHERE id = $1 AND organizer_id = $2`,
      [templateId, organizerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    res.json({ template: result.rows[0] });
  } catch (error) {
    console.error('Error fetching email template:', error);
    res.status(500).json({ error: 'Failed to fetch template' });
  }
});

// PUT /api/email-templates/:id - Update template
router.put('/:id', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const templateId = req.params.id;
    const { name, subject, body_html, body_text } = req.body;

    if (!name || !subject || !body_html) {
      return res.status(400).json({ error: 'Name, subject, and body_html are required' });
    }

    // Check template exists and belongs to organizer
    const existing = await pool.query(
      'SELECT id FROM email_templates WHERE id = $1 AND organizer_id = $2',
      [templateId, organizerId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const result = await pool.query(
      `UPDATE email_templates 
       SET name = $1, subject = $2, body_html = $3, body_text = $4
       WHERE id = $5 AND organizer_id = $6
       RETURNING id, name, subject, body_html, body_text, created_at`,
      [name.trim(), subject.trim(), body_html, body_text || null, templateId, organizerId]
    );

    res.json({ template: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/email-templates/:id error:', err);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

// DELETE /api/email-templates/:id - Delete template
router.delete('/:id', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const templateId = req.params.id;

    // Check template exists and belongs to organizer
    const existing = await pool.query(
      'SELECT id FROM email_templates WHERE id = $1 AND organizer_id = $2',
      [templateId, organizerId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    await pool.query(
      'DELETE FROM email_templates WHERE id = $1 AND organizer_id = $2',
      [templateId, organizerId]
    );

    res.json({ success: true, deleted_id: templateId });
  } catch (err) {
    console.error('DELETE /api/email-templates/:id error:', err);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

// ============================================
// TEMPLATE PREVIEW & CLONE
// ============================================

/**
 * Process template placeholders with recipient data.
 * Mirrors the logic from campaignSend.js processTemplate.
 */
function processTemplate(text, data, extras = {}) {
  if (!text) return "";

  const fullName = data.name || "";
  const nameParts = fullName.trim().split(/\s+/);
  const firstName = data.first_name || nameParts[0] || "";
  const lastName = data.last_name || (nameParts.length > 1 ? nameParts.slice(1).join(' ') : "");

  let processed = text;

  processed = processed.replace(/{{first_name}}/gi, firstName);
  processed = processed.replace(/{{last_name}}/gi, lastName);
  processed = processed.replace(/{{name}}/gi, fullName || `${firstName} ${lastName}`.trim());
  processed = processed.replace(/{{company_name}}/gi, data.company || "");
  processed = processed.replace(/{{company}}/gi, data.company || "");
  processed = processed.replace(/{{email}}/gi, data.email || "");
  processed = processed.replace(/{{country}}/gi, data.country || "");
  processed = processed.replace(/{{position}}/gi, data.position || "");
  processed = processed.replace(/{{website}}/gi, data.website || "");
  processed = processed.replace(/{{tag}}/gi, data.tag || "");

  if (extras.unsubscribe_url) {
    processed = processed.replace(/{{unsubscribe_url}}/gi, extras.unsubscribe_url);
    processed = processed.replace(/{{unsubscribe_link}}/gi, extras.unsubscribe_url);
  }

  return processed;
}

// POST /api/email-templates/:id/preview
router.post('/:id/preview', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const templateId = req.params.id;

    const result = await pool.query(
      `SELECT id, name, subject, body_html, body_text
       FROM email_templates
       WHERE id = $1 AND organizer_id = $2`,
      [templateId, organizerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const template = result.rows[0];

    const sampleData = req.body.sample_data || {
      first_name: "John",
      last_name: "Doe",
      name: "John Doe",
      company: "Acme Corp",
      email: "john@acme.com",
      country: "US",
      position: "Manager",
      website: "acme.com",
      tag: "Sample"
    };

    const extras = { unsubscribe_url: "#" };

    res.json({
      preview: {
        subject: processTemplate(template.subject, sampleData, extras),
        body_html: processTemplate(template.body_html, sampleData, extras),
        body_text: processTemplate(template.body_text || "", sampleData, extras)
      }
    });
  } catch (error) {
    console.error('Error previewing template:', error);
    res.status(500).json({ error: 'Failed to preview template' });
  }
});

// POST /api/email-templates/:id/clone
router.post('/:id/clone', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const templateId = req.params.id;

    const existing = await pool.query(
      `SELECT name, subject, body_html, body_text
       FROM email_templates
       WHERE id = $1 AND organizer_id = $2`,
      [templateId, organizerId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const source = existing.rows[0];
    const newName = req.body.name || `Copy of ${source.name}`;

    const result = await pool.query(
      `INSERT INTO email_templates
       (organizer_id, name, subject, body_html, body_text, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id, name, subject, body_html, body_text, created_at`,
      [organizerId, newName, source.subject, source.body_html, source.body_text]
    );

    res.status(201).json({ template: result.rows[0] });
  } catch (error) {
    console.error('Error cloning template:', error);
    res.status(500).json({ error: 'Failed to clone template' });
  }
});

// IMPORTANT: module.exports must be at the END of the file
module.exports = router;
