const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

/**
 * Simple auth middleware using Bearer token.
 */
function authRequired(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "Missing Authorization header" });
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const payload = jwt.verify(token, JWT_SECRET);

    req.auth = {
      user_id: payload.user_id,
      organizer_id: payload.organizer_id,
      role: payload.role
    };

    next();
  } catch (err) {
    console.error("Auth error:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * GET /api/reports/campaign/:id
 *
 * Returns summary metrics for a single campaign:
 * - campaign info
 * - recipient counts by status (pending/sent/failed)
 * - email_logs counts by status
 */
router.get('/api/reports/campaign/:id', authRequired, async (req, res) => {
  try {
    const campaign_id = req.params.id;
    const organizer_id = req.auth.organizer_id;

    // 1) Campaign + template info
    const campRes = await db.query(
      `SELECT 
         c.id,
         c.name,
         c.status,
         c.created_at,
         c.scheduled_at,
         c.template_id,
         t.subject,
         t.name AS template_name
       FROM campaigns c
       LEFT JOIN email_templates t ON c.template_id = t.id
       WHERE c.id = $1 AND c.organizer_id = $2`,
      [campaign_id, organizer_id]
    );

    if (campRes.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const campaign = campRes.rows[0];

    // 2) Recipient stats
    const recRes = await db.query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM campaign_recipients
       WHERE campaign_id = $1 AND organizer_id = $2`,
      [campaign_id, organizer_id]
    );

    const recStats = recRes.rows[0];

    // 3) Email logs stats by status
    const logRes = await db.query(
      `SELECT
         COUNT(*) AS total_logs,
         SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS logs_sent,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS logs_failed
       FROM email_logs
       WHERE campaign_id = $1 AND organizer_id = $2`,
      [campaign_id, organizer_id]
    );

    const logStats = logRes.rows[0];

    return res.json({
      success: true,
      campaign: {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        created_at: campaign.created_at,
        scheduled_at: campaign.scheduled_at,
        template_id: campaign.template_id,
        template_name: campaign.template_name,
        subject: campaign.subject
      },
      recipients: {
        total: parseInt(recStats.total || 0, 10),
        pending: parseInt(recStats.pending || 0, 10),
        sent: parseInt(recStats.sent || 0, 10),
        failed: parseInt(recStats.failed || 0, 10)
      },
      logs: {
        total: parseInt(logStats.total_logs || 0, 10),
        sent: parseInt(logStats.logs_sent || 0, 10),
        failed: parseInt(logStats.logs_failed || 0, 10)
      }
    });

  } catch (err) {
    console.error("GET /api/reports/campaign/:id error:", err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
