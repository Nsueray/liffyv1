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
 * Returns summary metrics for a single campaign.
 * Primary: campaign_events (canonical). Fallback: campaign_recipients.
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

    // 3) Event stats — campaign_events with campaign_recipients fallback
    const eventRes = await db.query(
      `SELECT event_type, COUNT(*) AS count
       FROM campaign_events
       WHERE campaign_id = $1 AND organizer_id = $2
       GROUP BY event_type`,
      [campaign_id, organizer_id]
    );

    const events = {};
    let totalEvents = 0;
    let dataSource = 'campaign_events';

    if (eventRes.rows.length > 0) {
      for (const row of eventRes.rows) {
        events[row.event_type] = parseInt(row.count, 10);
        totalEvents += parseInt(row.count, 10);
      }
    } else {
      // Fallback: derive events from campaign_recipients
      dataSource = 'campaign_recipients';
      const fbRes = await db.query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('sent','delivered','opened','clicked','bounced')) AS sent,
           COUNT(*) FILTER (WHERE delivered_at IS NOT NULL) AS delivered,
           COUNT(*) FILTER (WHERE opened_at IS NOT NULL) AS opened,
           COUNT(*) FILTER (WHERE clicked_at IS NOT NULL) AS clicked,
           COUNT(*) FILTER (WHERE bounced_at IS NOT NULL) AS bounced
         FROM campaign_recipients
         WHERE campaign_id = $1 AND organizer_id = $2`,
        [campaign_id, organizer_id]
      );
      const fb = fbRes.rows[0];
      events.sent = parseInt(fb.sent) || 0;
      events.delivered = parseInt(fb.delivered) || 0;
      events.open = parseInt(fb.opened) || 0;
      events.click = parseInt(fb.clicked) || 0;
      events.bounce = parseInt(fb.bounced) || 0;
      totalEvents = events.sent + events.delivered + events.open + events.click + events.bounce;
    }
    events.total = totalEvents;

    // 4) Timeline
    let timeline;
    if (dataSource === 'campaign_events') {
      const timelineRes = await db.query(
        `SELECT DATE(occurred_at) AS day, event_type, COUNT(*) AS count
         FROM campaign_events
         WHERE campaign_id = $1 AND organizer_id = $2
         GROUP BY DATE(occurred_at), event_type
         ORDER BY day ASC`,
        [campaign_id, organizer_id]
      );
      timeline = pivotTimeline(timelineRes.rows, 'day');
    } else {
      const timelineRes = await db.query(
        `SELECT day, event_type, COUNT(*) AS count FROM (
           SELECT DATE(sent_at) AS day, 'sent' AS event_type FROM campaign_recipients WHERE campaign_id = $1 AND organizer_id = $2 AND sent_at IS NOT NULL
           UNION ALL
           SELECT DATE(delivered_at), 'delivered' FROM campaign_recipients WHERE campaign_id = $1 AND organizer_id = $2 AND delivered_at IS NOT NULL
           UNION ALL
           SELECT DATE(opened_at), 'open' FROM campaign_recipients WHERE campaign_id = $1 AND organizer_id = $2 AND opened_at IS NOT NULL
           UNION ALL
           SELECT DATE(clicked_at), 'click' FROM campaign_recipients WHERE campaign_id = $1 AND organizer_id = $2 AND clicked_at IS NOT NULL
           UNION ALL
           SELECT DATE(bounced_at), 'bounce' FROM campaign_recipients WHERE campaign_id = $1 AND organizer_id = $2 AND bounced_at IS NOT NULL
         ) sub
         GROUP BY day, event_type
         ORDER BY day ASC`,
        [campaign_id, organizer_id]
      );
      timeline = pivotTimeline(timelineRes.rows, 'day');
    }

    // 5) Domain breakdown
    let domains;
    if (dataSource === 'campaign_events') {
      const domainRes = await db.query(
        `SELECT
           LOWER(split_part(email, '@', 2)) AS domain,
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE event_type = 'delivered') AS delivered,
           COUNT(*) FILTER (WHERE event_type = 'bounce') AS bounced,
           COUNT(*) FILTER (WHERE event_type = 'open') AS opened
         FROM campaign_events
         WHERE campaign_id = $1 AND organizer_id = $2
         GROUP BY domain
         ORDER BY total DESC
         LIMIT 50`,
        [campaign_id, organizer_id]
      );
      domains = mapDomains(domainRes.rows);
    } else {
      const domainRes = await db.query(
        `SELECT
           LOWER(split_part(email, '@', 2)) AS domain,
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE delivered_at IS NOT NULL) AS delivered,
           COUNT(*) FILTER (WHERE bounced_at IS NOT NULL) AS bounced,
           COUNT(*) FILTER (WHERE opened_at IS NOT NULL) AS opened
         FROM campaign_recipients
         WHERE campaign_id = $1 AND organizer_id = $2
         GROUP BY domain
         ORDER BY total DESC
         LIMIT 50`,
        [campaign_id, organizer_id]
      );
      domains = mapDomains(domainRes.rows);
    }

    // 6) Bounce reasons
    let bounce_reasons;
    if (dataSource === 'campaign_events') {
      const bounceRes = await db.query(
        `SELECT COALESCE(reason, 'unknown') AS reason, COUNT(*) AS count
         FROM campaign_events
         WHERE campaign_id = $1 AND organizer_id = $2 AND event_type = 'bounce'
         GROUP BY reason
         ORDER BY count DESC
         LIMIT 20`,
        [campaign_id, organizer_id]
      );
      bounce_reasons = bounceRes.rows.map(r => ({ reason: r.reason, count: parseInt(r.count || 0, 10) }));
    } else {
      const bounceRes = await db.query(
        `SELECT COALESCE(last_error, 'unknown') AS reason, COUNT(*) AS count
         FROM campaign_recipients
         WHERE campaign_id = $1 AND organizer_id = $2 AND bounced_at IS NOT NULL
         GROUP BY last_error
         ORDER BY count DESC
         LIMIT 20`,
        [campaign_id, organizer_id]
      );
      bounce_reasons = bounceRes.rows.map(r => ({ reason: r.reason, count: parseInt(r.count || 0, 10) }));
    }

    return res.json({
      success: true,
      data_source: dataSource,
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
 * High-level metrics for all campaigns of the organizer.
 * Primary: campaign_events (canonical). Fallback: campaign_recipients.
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

    // 3) Event stats — campaign_events with campaign_recipients fallback
    const eventRes = await db.query(
      `SELECT event_type, COUNT(*) AS count
       FROM campaign_events
       WHERE organizer_id = $1
       GROUP BY event_type`,
      [organizer_id]
    );

    const events = {};
    let totalEvents = 0;
    let dataSource = 'campaign_events';

    if (eventRes.rows.length > 0) {
      for (const row of eventRes.rows) {
        events[row.event_type] = parseInt(row.count, 10);
        totalEvents += parseInt(row.count, 10);
      }
    } else {
      // Fallback: derive from campaign_recipients timestamps
      dataSource = 'campaign_recipients';
      const fbRes = await db.query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('sent','delivered','opened','clicked','bounced')) AS sent,
           COUNT(*) FILTER (WHERE delivered_at IS NOT NULL) AS delivered,
           COUNT(*) FILTER (WHERE opened_at IS NOT NULL) AS opened,
           COUNT(*) FILTER (WHERE clicked_at IS NOT NULL) AS clicked,
           COUNT(*) FILTER (WHERE bounced_at IS NOT NULL) AS bounced
         FROM campaign_recipients
         WHERE organizer_id = $1`,
        [organizer_id]
      );
      const fb = fbRes.rows[0];
      events.sent = parseInt(fb.sent) || 0;
      events.delivered = parseInt(fb.delivered) || 0;
      events.open = parseInt(fb.opened) || 0;
      events.click = parseInt(fb.clicked) || 0;
      events.bounce = parseInt(fb.bounced) || 0;
      totalEvents = events.sent + events.delivered + events.open + events.click + events.bounce;
    }
    events.total = totalEvents;

    // 4) Timeline
    let timeline;
    if (dataSource === 'campaign_events') {
      const timelineRes = await db.query(
        `SELECT DATE(occurred_at) AS day, event_type, COUNT(*) AS count
         FROM campaign_events
         WHERE organizer_id = $1
         GROUP BY DATE(occurred_at), event_type
         ORDER BY day ASC`,
        [organizer_id]
      );
      timeline = pivotTimeline(timelineRes.rows, 'day');
    } else {
      const timelineRes = await db.query(
        `SELECT day, event_type, COUNT(*) AS count FROM (
           SELECT DATE(sent_at) AS day, 'sent' AS event_type FROM campaign_recipients WHERE organizer_id = $1 AND sent_at IS NOT NULL
           UNION ALL
           SELECT DATE(delivered_at), 'delivered' FROM campaign_recipients WHERE organizer_id = $1 AND delivered_at IS NOT NULL
           UNION ALL
           SELECT DATE(opened_at), 'open' FROM campaign_recipients WHERE organizer_id = $1 AND opened_at IS NOT NULL
           UNION ALL
           SELECT DATE(clicked_at), 'click' FROM campaign_recipients WHERE organizer_id = $1 AND clicked_at IS NOT NULL
           UNION ALL
           SELECT DATE(bounced_at), 'bounce' FROM campaign_recipients WHERE organizer_id = $1 AND bounced_at IS NOT NULL
         ) sub
         GROUP BY day, event_type
         ORDER BY day ASC`,
        [organizer_id]
      );
      timeline = pivotTimeline(timelineRes.rows, 'day');
    }

    // 5) Domain breakdown
    let domains;
    if (dataSource === 'campaign_events') {
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
      domains = mapDomains(domainRes.rows);
    } else {
      const domainRes = await db.query(
        `SELECT
           LOWER(split_part(email, '@', 2)) AS domain,
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE delivered_at IS NOT NULL) AS delivered,
           COUNT(*) FILTER (WHERE bounced_at IS NOT NULL) AS bounced,
           COUNT(*) FILTER (WHERE opened_at IS NOT NULL) AS opened
         FROM campaign_recipients
         WHERE organizer_id = $1
         GROUP BY domain
         ORDER BY total DESC
         LIMIT 50`,
        [organizer_id]
      );
      domains = mapDomains(domainRes.rows);
    }

    // 6) Bounce reasons
    let bounce_reasons;
    if (dataSource === 'campaign_events') {
      const bounceRes = await db.query(
        `SELECT COALESCE(reason, 'unknown') AS reason, COUNT(*) AS count
         FROM campaign_events
         WHERE organizer_id = $1 AND event_type = 'bounce'
         GROUP BY reason
         ORDER BY count DESC
         LIMIT 20`,
        [organizer_id]
      );
      bounce_reasons = bounceRes.rows.map(r => ({ reason: r.reason, count: parseInt(r.count || 0, 10) }));
    } else {
      const bounceRes = await db.query(
        `SELECT COALESCE(last_error, 'unknown') AS reason, COUNT(*) AS count
         FROM campaign_recipients
         WHERE organizer_id = $1 AND bounced_at IS NOT NULL
         GROUP BY last_error
         ORDER BY count DESC
         LIMIT 20`,
        [organizer_id]
      );
      bounce_reasons = bounceRes.rows.map(r => ({ reason: r.reason, count: parseInt(r.count || 0, 10) }));
    }

    return res.json({
      success: true,
      data_source: dataSource,
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

// --- Helpers ---

function pivotTimeline(rows, dateKey) {
  const map = {};
  for (const row of rows) {
    const key = row[dateKey];
    if (!key) continue;
    if (!map[key]) {
      map[key] = { date: key, total: 0 };
    }
    const count = parseInt(row.count, 10);
    map[key][row.event_type] = count;
    map[key].total += count;
  }
  return Object.values(map);
}

function mapDomains(rows) {
  return rows.map(r => ({
    domain: r.domain || 'unknown',
    total: parseInt(r.total || 0, 10),
    delivered: parseInt(r.delivered || 0, 10),
    bounced: parseInt(r.bounced || 0, 10),
    opened: parseInt(r.opened || 0, 10)
  }));
}

module.exports = router;
