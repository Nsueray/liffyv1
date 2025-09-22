const express = require('express');
const router = express.Router();
const campaigns = require('../models/campaigns');

router.post('/api/campaigns', async (req, res) => {
  try {
    const { organizer_id, template_id, name, scheduled_at } = req.body;
    if (!organizer_id || !template_id || !name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const campaign = await campaigns.createCampaign(
      organizer_id, template_id, name, scheduled_at
    );
    res.json(campaign);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/api/campaigns', async (req, res) => {
  try {
    const { organizer_id } = req.query;
    if (!organizer_id) {
      return res.status(400).json({ error: 'organizer_id is required' });
    }
    const campaignList = await campaigns.getCampaignsByOrganizer(organizer_id);
    res.json(campaignList);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/api/campaigns/:id', async (req, res) => {
  try {
    const campaign = await campaigns.getCampaignById(req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    res.json(campaign);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/api/campaigns/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }
    const campaign = await campaigns.updateCampaignStatus(req.params.id, status);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    res.json(campaign);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/api/campaigns/:id', async (req, res) => {
  try {
    const campaign = await campaigns.deleteCampaign(req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    res.json({ message: 'Campaign deleted successfully', campaign });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
