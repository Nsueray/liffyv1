const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

function authRequired(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No token" });
  const token = authHeader.replace("Bearer ", "").trim();
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// GET /api/logs — List campaign events (migrated from email_logs to campaign_events)
router.get('/api/logs', authRequired, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;
    const { campaign_id, event_type } = req.query;
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    let where = ['ce.organizer_id = $1'];
    const params = [organizer_id];
    let idx = 2;

    if (campaign_id) {
      where.push(`ce.campaign_id = $${idx}`);
      params.push(campaign_id);
      idx++;
    }

    if (event_type) {
      where.push(`ce.event_type = $${idx}`);
      params.push(event_type);
      idx++;
    }

    const whereClause = where.join(' AND ');

    const countRes = await db.query(
      `SELECT COUNT(*) FROM campaign_events ce WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const dataRes = await db.query(
      `SELECT
         ce.id,
         ce.campaign_id,
         ce.recipient_id,
         ce.email AS recipient_email,
         ce.event_type AS status,
         ce.reason,
         ce.url,
         ce.provider_event_id,
         ce.provider_response,
         ce.occurred_at AS sent_at,
         ce.created_at
       FROM campaign_events ce
       WHERE ${whereClause}
       ORDER BY ce.occurred_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    );

    res.json({ total, logs: dataRes.rows });
  } catch (err) {
    console.error('GET /api/logs error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs/:id — Single event detail
router.get('/api/logs/:id', authRequired, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;
    const logId = req.params.id;

    const result = await db.query(
      `SELECT
         ce.id,
         ce.campaign_id,
         ce.recipient_id,
         ce.person_id,
         ce.email AS recipient_email,
         ce.event_type AS status,
         ce.reason,
         ce.url,
         ce.user_agent,
         ce.ip_address,
         ce.provider_event_id,
         ce.provider_response,
         ce.occurred_at AS sent_at,
         ce.created_at
       FROM campaign_events ce
       WHERE ce.id = $1 AND ce.organizer_id = $2`,
      [logId, organizer_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Log not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET /api/logs/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
