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

// GET /api/unsubscribes
router.get('/', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;
    const search = req.query.search ? req.query.search.trim() : null;
    const sourceFilter = req.query.source ? req.query.source.trim() : null;

    // Build WHERE conditions
    let conditions = ['u.organizer_id = $1'];
    let params = [organizerId];
    let paramIndex = 2;

    if (search) {
      conditions.push(`u.email ILIKE $${paramIndex}`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (sourceFilter) {
      conditions.push(`COALESCE(u.source, u.reason, 'unknown') = $${paramIndex}`);
      params.push(sourceFilter);
      paramIndex++;
    }

    const whereClause = conditions.join(' AND ');

    // Count total
    const countResult = await db.query(
      `SELECT COUNT(*) FROM unsubscribes u WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10) || 0;

    // Fetch unsubscribes with campaign info via LATERAL join
    const dataResult = await db.query(
      `SELECT
         u.id,
         u.email,
         COALESCE(u.source, u.reason, 'unknown') AS source,
         u.created_at,
         ce.campaign_id,
         c.name AS campaign_name
       FROM unsubscribes u
       LEFT JOIN LATERAL (
         SELECT ce2.campaign_id
         FROM campaign_events ce2
         JOIN campaign_recipients cr ON cr.id = ce2.recipient_id
         WHERE LOWER(cr.email) = LOWER(u.email)
           AND cr.organizer_id = u.organizer_id
           AND ce2.event_type IN ('unsubscribe', 'spam_report')
         ORDER BY ce2.created_at DESC
         LIMIT 1
       ) ce ON true
       LEFT JOIN campaigns c ON c.id = ce.campaign_id
       WHERE ${whereClause}
       ORDER BY u.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    // Stats: total by source
    const statsResult = await db.query(
      `SELECT
         COALESCE(source, reason, 'unknown') AS source,
         COUNT(*) AS count
       FROM unsubscribes
       WHERE organizer_id = $1
       GROUP BY COALESCE(source, reason, 'unknown')`,
      [organizerId]
    );

    const bySource = {};
    let statsTotal = 0;
    for (const row of statsResult.rows) {
      const count = parseInt(row.count, 10) || 0;
      bySource[row.source] = count;
      statsTotal += count;
    }

    res.json({
      unsubscribes: dataResult.rows,
      pagination: {
        total,
        page,
        limit,
        total_pages: Math.ceil(total / limit)
      },
      stats: {
        total: statsTotal,
        by_source: bySource
      }
    });
  } catch (err) {
    console.error('GET /api/unsubscribes error:', err);
    res.status(500).json({ error: 'Failed to fetch unsubscribes' });
  }
});

module.exports = router;
