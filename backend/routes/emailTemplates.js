const express = require('express');
const router = express.Router();
const emailTemplates = require('../models/emailTemplates');

router.post('/api/templates', async (req, res) => {
  try {
    const { organizer_id, name, subject, body_html, body_text } = req.body;
    if (!organizer_id || !name || !subject || !body_html) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const template = await emailTemplates.createTemplate(
      organizer_id, name, subject, body_html, body_text
    );
    res.json(template);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/api/templates', async (req, res) => {
  try {
    const { organizer_id } = req.query;
    if (!organizer_id) {
      return res.status(400).json({ error: 'organizer_id is required' });
    }
    const templates = await emailTemplates.getTemplatesByOrganizer(organizer_id);
    res.json(templates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/api/templates/:id', async (req, res) => {
  try {
    const template = await emailTemplates.getTemplateById(req.params.id);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    res.json(template);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/api/templates/:id', async (req, res) => {
  try {
    const { name, subject, body_html, body_text } = req.body;
    if (!name || !subject || !body_html) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const template = await emailTemplates.updateTemplate(
      req.params.id, name, subject, body_html, body_text
    );
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    res.json(template);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/api/templates/:id', async (req, res) => {
  try {
    const template = await emailTemplates.deleteTemplate(req.params.id);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    res.json({ message: 'Template deleted successfully', template });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
