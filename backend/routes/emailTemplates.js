const express = require('express');
const router = express.Router();
const pool = require('../db');
const jwt = require('jsonwebtoken');
const { processTemplate } = require('../utils/templateProcessor');
const { getUserContext, isPrivileged, getUpwardVisibilityScope, canAccessRowHierarchical } = require('../middleware/userScope');

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

const TEMPLATE_COLS = `id, name, subject, body_html, body_text, visibility, created_by_user_id, created_at`;

// GET /api/email-templates
router.get('/', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const scope = getUpwardVisibilityScope(req, 'created_by_user_id', 'visibility', 2);

    const result = await pool.query(
      `SELECT ${TEMPLATE_COLS}
       FROM email_templates
       WHERE organizer_id = $1 ${scope.sql}
       ORDER BY created_at DESC`,
      [organizerId, ...scope.params]
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
    const userId = req.auth.user_id;
    const { name, subject, body_html, body_text, visibility } = req.body;

    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!subject || !subject.trim()) return res.status(400).json({ error: 'Subject is required' });
    if (!body_html || !body_html.trim()) return res.status(400).json({ error: 'Body HTML is required' });

    const vis = (visibility === 'private') ? 'private' : 'public';

    const result = await pool.query(
      `INSERT INTO email_templates
       (organizer_id, created_by_user_id, name, subject, body_html, body_text, visibility, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING ${TEMPLATE_COLS}`,
      [organizerId, userId, name.trim(), subject.trim(), body_html, body_text || null, vis]
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
    const scope = getUpwardVisibilityScope(req, 'created_by_user_id', 'visibility', 3);

    const result = await pool.query(
      `SELECT ${TEMPLATE_COLS}
       FROM email_templates
       WHERE id = $1 AND organizer_id = $2 ${scope.sql}`,
      [templateId, organizerId, ...scope.params]
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
    const { name, subject, body_html, body_text, visibility } = req.body;

    if (!name || !subject || !body_html) {
      return res.status(400).json({ error: 'Name, subject, and body_html are required' });
    }

    // Check template exists and user can access it
    const existing = await pool.query(
      'SELECT id, created_by_user_id FROM email_templates WHERE id = $1 AND organizer_id = $2',
      [templateId, organizerId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    // Only creator or privileged user can update
    const ownerId = existing.rows[0].created_by_user_id;
    if (ownerId && !(await canAccessRowHierarchical(req, ownerId))) {
      return res.status(403).json({ error: 'You can only edit your own templates' });
    }

    // Only owner/admin can change visibility
    const vis = (visibility === 'private' || visibility === 'public') ? visibility : undefined;
    const visSql = vis ? ', visibility = $7' : '';
    const visParams = vis ? [vis] : [];

    const result = await pool.query(
      `UPDATE email_templates
       SET name = $1, subject = $2, body_html = $3, body_text = $4${visSql}
       WHERE id = $5 AND organizer_id = $6
       RETURNING ${TEMPLATE_COLS}`,
      [name.trim(), subject.trim(), body_html, body_text || null, ...visParams, templateId, organizerId]
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

    // Check template exists and user can access it
    const existing = await pool.query(
      'SELECT id, created_by_user_id FROM email_templates WHERE id = $1 AND organizer_id = $2',
      [templateId, organizerId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const ownerId = existing.rows[0].created_by_user_id;
    if (ownerId && !(await canAccessRowHierarchical(req, ownerId))) {
      return res.status(403).json({ error: 'You can only delete your own templates' });
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

// POST /api/email-templates/:id/preview
router.post('/:id/preview', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const templateId = req.params.id;
    const scope = getUpwardVisibilityScope(req, 'created_by_user_id', 'visibility', 3);

    const result = await pool.query(
      `SELECT id, name, subject, body_html, body_text
       FROM email_templates
       WHERE id = $1 AND organizer_id = $2 ${scope.sql}`,
      [templateId, organizerId, ...scope.params]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const template = result.rows[0];

    const rawSample = req.body.sample_data || {
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

    // Wrap flat sample data as a recipient-like object for shared processTemplate
    const recipient = {
      name: rawSample.name || "",
      email: rawSample.email || "",
      meta: rawSample
    };

    const extras = { unsubscribe_url: "#" };

    res.json({
      preview: {
        subject: processTemplate(template.subject, recipient, extras),
        body_html: processTemplate(template.body_html, recipient, extras),
        body_text: processTemplate(template.body_text || "", recipient, extras)
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
    const userId = req.auth.user_id;
    const templateId = req.params.id;
    const scope = getUpwardVisibilityScope(req, 'created_by_user_id', 'visibility', 3);

    const existing = await pool.query(
      `SELECT name, subject, body_html, body_text
       FROM email_templates
       WHERE id = $1 AND organizer_id = $2 ${scope.sql}`,
      [templateId, organizerId, ...scope.params]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const source = existing.rows[0];
    const newName = req.body.name || `Copy of ${source.name}`;

    const result = await pool.query(
      `INSERT INTO email_templates
       (organizer_id, created_by_user_id, name, subject, body_html, body_text, visibility, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'public', NOW())
       RETURNING ${TEMPLATE_COLS}`,
      [organizerId, userId, newName, source.subject, source.body_html, source.body_text]
    );

    res.status(201).json({ template: result.rows[0] });
  } catch (error) {
    console.error('Error cloning template:', error);
    res.status(500).json({ error: 'Failed to clone template' });
  }
});

// IMPORTANT: module.exports must be at the END of the file
module.exports = router;
