/**
 * Stats API - Dashboard sidebar counts
 * GET /api/stats - Returns running jobs, leads, active campaigns counts
 */

const express = require('express');
const router = express.Router();
const db = require('../db');

// Auth middleware (same pattern as other routes)
const authRequired = (req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// GET /api/stats - Get sidebar counts
router.get('/api/stats', authRequired, async (req, res) => {
  try {
    const organizerId = req.session.user.organizer_id;
    
    // Count running/pending mining jobs
    const jobsResult = await db.query(
      `SELECT COUNT(*) as count FROM mining_jobs 
       WHERE organizer_id = $1 AND status IN ('pending', 'running')`,
      [organizerId]
    );
    
    // Count total leads (mining_results)
    const leadsResult = await db.query(
      `SELECT COUNT(*) as count FROM mining_results 
       WHERE organizer_id = $1`,
      [organizerId]
    );
    
    // Count active campaigns (not completed/cancelled)
    const campaignsResult = await db.query(
      `SELECT COUNT(*) as count FROM campaigns 
       WHERE organizer_id = $1 AND status IN ('draft', 'scheduled', 'sending')`,
      [organizerId]
    );
    
    res.json({
      runningJobs: parseInt(jobsResult.rows[0]?.count || 0),
      newLeads: parseInt(leadsResult.rows[0]?.count || 0),
      activeCampaigns: parseInt(campaignsResult.rows[0]?.count || 0)
    });
    
  } catch (err) {
    console.error('[Stats API] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;
