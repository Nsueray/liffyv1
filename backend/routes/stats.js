/**
 * Stats API - Dashboard sidebar counts
 * GET /api/stats - Returns running jobs, leads, active campaigns counts
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

function authRequired(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing Authorization header' });
    }
    const token = authHeader.replace('Bearer ', '').trim();
    const payload = jwt.verify(token, JWT_SECRET);
    req.auth = {
      user_id: payload.user_id,
      organizer_id: payload.organizer_id,
      role: payload.role
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// GET /api/stats - Get sidebar counts
router.get('/api/stats', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    
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
