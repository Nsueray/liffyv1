const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

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
 * Returns summary metrics for a single campaign using campaign_events (canonical):
 * - campaign info
 * - recipient counts by status
 * - event counts by type
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

    // 3) Event stats by type (from campaign_events — canonical)
    const eventRes = await db.query(
      `SELECT
         event_type,
         COUNT(*) AS count
       FROM campaign_events
       WHERE campaign_id = $1 AND organizer_id = $2
       GROUP BY event_type`,
      [campaign_id, organizer_id]
    );

    const events = {};
    let totalEvents = 0;
    for (const row of eventRes.rows) {
      events[row.event_type] = parseInt(row.count, 10);
      totalEvents += parseInt(row.count, 10);
    }
    events.total = totalEvents;

    // 4) Timeline (per day, from campaign_events)
    const timelineRes = await db.query(
      `SELECT
         DATE(occurred_at) AS day,
         event_type,
         COUNT(*) AS count
       FROM campaign_events
       WHERE campaign_id = $1
         AND organizer_id = $2
       GROUP BY DATE(occurred_at), event_type
       ORDER BY day ASC`,
      [campaign_id, organizer_id]
    );

    // Pivot timeline: group by day, each event_type as a column
    const timelineMap = {};
    for (const row of timelineRes.rows) {
      const day = row.day;
      if (!timelineMap[day]) {
        timelineMap[day] = { date: day, total: 0 };
      }
      const count = parseInt(row.count, 10);
      timelineMap[day][row.event_type] = count;
      timelineMap[day].total += count;
    }
    const timeline = Object.values(timelineMap);

    // 5) Domain breakdown (from campaign_events)
    const domainRes = await db.query(
      `SELECT
         LOWER(split_part(email, '@', 2)) AS domain,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE event_type = 'delivered') AS delivered,
         COUNT(*) FILTER (WHERE event_type = 'bounce') AS bounced,
         COUNT(*) FILTER (WHERE event_type = 'open') AS opened
       FROM campaign_events
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
      delivered: parseInt(r.delivered || 0, 10),
      bounced: parseInt(r.bounced || 0, 10),
      opened: parseInt(r.opened || 0, 10)
    }));

    // 6) Bounce reasons (from campaign_events)
    const bounceRes = await db.query(
      `SELECT
         COALESCE(reason, 'unknown') AS reason,
         COUNT(*) AS count
       FROM campaign_events
       WHERE campaign_id = $1
         AND organizer_id = $2
         AND event_type = 'bounce'
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
      events,
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
 * High-level metrics for all campaigns of the organizer using campaign_events (canonical):
 * - campaign counts by status
 * - recipient counts
 * - event counts by type
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

    // 3) Event stats by type (from campaign_events — canonical)
    const eventRes = await db.query(
      `SELECT
         event_type,
         COUNT(*) AS count
       FROM campaign_events
       WHERE organizer_id = $1
       GROUP BY event_type`,
      [organizer_id]
    );

    const events = {};
    let totalEvents = 0;
    for (const row of eventRes.rows) {
      events[row.event_type] = parseInt(row.count, 10);
      totalEvents += parseInt(row.count, 10);
    }
    events.total = totalEvents;

    // 4) Timeline (per day, all campaigns, from campaign_events)
    const timelineRes = await db.query(
      `SELECT
         DATE(occurred_at) AS day,
         event_type,
         COUNT(*) AS count
       FROM campaign_events
       WHERE organizer_id = $1
       GROUP BY DATE(occurred_at), event_type
       ORDER BY day ASC`,
      [organizer_id]
    );

    const timelineMap = {};
    for (const row of timelineRes.rows) {
      const day = row.day;
      if (!timelineMap[day]) {
        timelineMap[day] = { date: day, total: 0 };
      }
      const count = parseInt(row.count, 10);
      timelineMap[day][row.event_type] = count;
      timelineMap[day].total += count;
    }
    const timeline = Object.values(timelineMap);

    // 5) Domain breakdown (all campaigns, from campaign_events)
    const domainRes = await db.query(
      `SELECT
         LOWER(split_part(email, '@', 2)) AS domain,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE event_type = 'delivered') AS delivered,
         COUNT(*) FILTER (WHERE event_type = 'bounce') AS bounced,
         COUNT(*) FILTER (WHERE event_type = 'open') AS opened
       FROM campaign_events
       WHERE organizer_id = $1
       GROUP BY domain
       ORDER BY total DESC
       LIMIT 50`,
      [organizer_id]
    );
    const domains = domainRes.rows.map(r => ({
      domain: r.domain || 'unknown',
      total: parseInt(r.total || 0, 10),
      delivered: parseInt(r.delivered || 0, 10),
      bounced: parseInt(r.bounced || 0, 10),
      opened: parseInt(r.opened || 0, 10)
    }));

    // 6) Bounce reasons (all campaigns, from campaign_events)
    const bounceRes = await db.query(
      `SELECT
         COALESCE(reason, 'unknown') AS reason,
         COUNT(*) AS count
       FROM campaign_events
       WHERE organizer_id = $1
         AND event_type = 'bounce'
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
      events,
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
