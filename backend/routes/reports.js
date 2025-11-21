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
 * - timeline (per day)
 * - domain breakdown
 * - bounce reasons
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

    // 4) Timeline (per day)
    const timelineRes = await db.query(
      `SELECT
         DATE(sent_at) AS day,
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM email_logs
       WHERE campaign_id = $1
         AND organizer_id = $2
         AND sent_at IS NOT NULL
       GROUP BY DATE(sent_at)
       ORDER BY day ASC`,
      [campaign_id, organizer_id]
    );

    const timeline = timelineRes.rows.map(r => ({
      date: r.day,
      total: parseInt(r.total || 0, 10),
      sent: parseInt(r.sent || 0, 10),
      failed: parseInt(r.failed || 0, 10)
    }));

    // 5) Domain breakdown
    const domainRes = await db.query(
      `SELECT
         LOWER(split_part(recipient_email, '@', 2)) AS domain,
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM email_logs
       WHERE campaign_id = $1
         AND organizer_id = $2
       GROUP BY domain
       ORDER BY total DESC
       LIMIT 50`,
      [campaign_id, organizer_id]
    );

    const domains = domainRes.rows.map(r => ({
      domain: r.domain || 'unknown',
      total: parseInt(r.total || 0, 10),
      sent: parseInt(r.sent || 0, 10),
      failed: parseInt(r.failed || 0, 10)
    }));

    // 6) Bounce reasons
    const bounceRes = await db.query(
      `SELECT
         COALESCE(provider_response->>'error', 'unknown') AS reason,
         COUNT(*) AS count
       FROM email_logs
       WHERE campaign_id = $1
         AND organizer_id = $2
         AND status = 'failed'
       GROUP BY reason
       ORDER BY count DESC
       LIMIT 20`,
      [campaign_id, organizer_id]
    );

    const bounce_reasons = bounceRes.rows.map(r => ({
      reason: r.reason,
      count: parseInt(r.count || 0, 10)
    }));

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
      },
      timeline,
      domains,
      bounce_reasons
    });

  } catch (err) {
    console.error("GET /api/reports/campaign/:id error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/reports/organizer/overview
 *
 * High-level metrics for all campaigns of the organizer:
 * - campaign counts by status
 * - recipient counts
 * - email log counts
 * - timeline (per day)
 * - domain breakdown
 * - bounce reasons
 */
router.get('/api/reports/organizer/overview', authRequired, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;

    // 1) Campaign stats
    const campRes = await db.query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft,
         SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled,
         SUM(CASE WHEN status = 'sending' THEN 1 ELSE 0 END) AS sending,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM campaigns
       WHERE organizer_id = $1`,
      [organizer_id]
    );
    const campStats = campRes.rows[0];

    // 2) Recipient stats (all campaigns)
    const recRes = await db.query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM campaign_recipients
       WHERE organizer_id = $1`,
      [organizer_id]
    );
    const recStats = recRes.rows[0];

    // 3) Log stats (all campaigns)
    const logRes = await db.query(
      `SELECT
         COUNT(*) AS total_logs,
         SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS logs_sent,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS logs_failed
       FROM email_logs
       WHERE organizer_id = $1`,
      [organizer_id]
    );
    const logStats = logRes.rows[0];

    // 4) Timeline (per day, all campaigns)
    const timelineRes = await db.query(
      `SELECT
         DATE(sent_at) AS day,
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM email_logs
       WHERE organizer_id = $1
         AND sent_at IS NOT NULL
       GROUP BY DATE(sent_at)
       ORDER BY day ASC`,
      [organizer_id]
    );
    const timeline = timelineRes.rows.map(r => ({
      date: r.day,
      total: parseInt(r.total || 0, 10),
      sent: parseInt(r.sent || 0, 10),
      failed: parseInt(r.failed || 0, 10)
    }));

    // 5) Domain breakdown (all campaigns)
    const domainRes = await db.query(
      `SELECT
         LOWER(split_part(recipient_email, '@', 2)) AS domain,
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM email_logs
       WHERE organizer_id = $1
       GROUP BY domain
       ORDER BY total DESC
       LIMIT 50`,
      [organizer_id]
    );
    const domains = domainRes.rows.map(r => ({
      domain: r.domain || 'unknown',
      total: parseInt(r.total || 0, 10),
      sent: parseInt(r.sent || 0, 10),
      failed: parseInt(r.failed || 0, 10)
    }));

    // 6) Bounce reasons (all campaigns)
    const bounceRes = await db.query(
      `SELECT
         COALESCE(provider_response->>'error', 'unknown') AS reason,
         COUNT(*) AS count
       FROM email_logs
       WHERE organizer_id = $1
         AND status = 'failed'
       GROUP BY reason
       ORDER BY count DESC
       LIMIT 20`,
      [organizer_id]
    );
    const bounce_reasons = bounceRes.rows.map(r => ({
      reason: r.reason,
      count: parseInt(r.count || 0, 10)
    }));

    return res.json({
      success: true,
      campaigns: {
        total: parseInt(campStats.total || 0, 10),
        draft: parseInt(campStats.draft || 0, 10),
        scheduled: parseInt(campStats.scheduled || 0, 10),
        sending: parseInt(campStats.sending || 0, 10),
        completed: parseInt(campStats.completed || 0, 10),
        failed: parseInt(campStats.failed || 0, 10)
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
      },
      timeline,
      domains,
      bounce_reasons
    });

  } catch (err) {
    console.error("GET /api/reports/organizer/overview error:", err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
