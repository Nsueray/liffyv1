const express = require('express');
const router = express.Router();
const emailLogs = require('../models/emailLogs');

router.post('/api/logs', async (req, res) => {
  try {
    const { organizer_id, campaign_id, template_id, recipient_email, recipient_data } = req.body;
    if (!organizer_id || !recipient_email) {
      return res.status(400).json({ error: 'organizer_id and recipient_email are required' });
    }
    const log = await emailLogs.createLog({
      organizerId: organizer_id,
      campaignId: campaign_id,
      templateId: template_id,
      recipientEmail: recipient_email,
      recipientData: recipient_data
    });
    res.json(log);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/api/logs/:id/status', async (req, res) => {
  try {
    const { status, provider_response } = req.body;
    if (!status) {
      return res.status(400).json({ error: 'status is required' });
    }
    const validStatuses = ['queued', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'failed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }
    const log = await emailLogs.updateLogStatus(req.params.id, status, provider_response);
    if (!log) {
      return res.status(404).json({ error: 'Log not found' });
    }
    res.json(log);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/api/logs', async (req, res) => {
  try {
    const { campaign_id, organizer_id, limit = 100, offset = 0 } = req.query;
    let logs;
    
    if (campaign_id) {
      logs = await emailLogs.getLogsByCampaign(campaign_id, parseInt(limit), parseInt(offset));
    } else if (organizer_id) {
      logs = await emailLogs.getLogsByOrganizer(organizer_id, { 
        limit: parseInt(limit), 
        offset: parseInt(offset) 
      });
    } else {
      return res.status(400).json({ error: 'campaign_id or organizer_id is required' });
    }
    
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/api/logs/:id', async (req, res) => {
  try {
    const log = await emailLogs.getLogById(req.params.id);
    if (!log) {
      return res.status(404).json({ error: 'Log not found' });
    }
    res.json(log);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

