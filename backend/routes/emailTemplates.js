const express = require('express');
const router = express.Router();
const pool = require('../db');
const jwt = require('jsonwebtoken');

const authRequired = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization token required' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.auth = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

router.get('/', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    if (!organizerId) {
      return res.status(403).json({ error: 'Organizer ID not found in token' });
    }

    const result = await pool.query(
      `SELECT id, name, subject, body_html, body_text, created_at, updated_at 
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

router.post('/', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    if (!organizerId) {
      return res.status(403).json({ error: 'Organizer ID not found in token' });
    }

    const { name, subject, body_html, body_text } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (!subject || !subject.trim()) {
      return res.status(400).json({ error: 'Subject is required' });
    }
    if (!body_html || !body_html.trim()) {
      return res.status(400).json({ error: 'Body HTML is required' });
    }

    const result = await pool.query(
      `INSERT INTO email_templates (organizer_id, name, subject, body_html, body_text, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       RETURNING id, name, subject, body_html, body_text, created_at, updated_at`,
      [organizerId, name.trim(), subject.trim(), body_html, body_text || null]
    );

    res.status(201).json({ template: result.rows[0] });
  } catch (error) {
    console.error('Error creating email template:', error);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

module.exports = router;
