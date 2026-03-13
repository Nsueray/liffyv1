const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

/**
 * Auth middleware
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
 * POST /api/prospects
 * Add one or multiple prospects
 */
router.post('/api/prospects', authRequired, async (req, res) => {
  try {
    let { prospects } = req.body;
    const organizer_id = req.auth.organizer_id;

    if (!prospects) {
      return res.status(400).json({ error: "prospects array required" });
    }
    if (!Array.isArray(prospects)) {
      prospects = [prospects];
    }

    const values = [];
    const placeholders = [];

    prospects.forEach((p, i) => {
      if (!p.email) return;

      const idx = i * 10;

      values.push(
        organizer_id,
        p.email,
        p.name || null,
        p.company || null,
        p.country || null,
        p.sector || null,
        p.source_type || 'manual',
        p.source_ref || null,
        p.verification_status || 'unknown',
        p.meta || null
      );

      placeholders.push(
        `($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, $${idx + 8}, $${idx + 9}, $${idx + 10})`
      );
    });

    if (values.length === 0) {
      return res.status(400).json({ error: "No valid prospects" });
    }

    const result = await db.query(
      `INSERT INTO prospects 
       (organizer_id, email, name, company, country, sector, source_type, source_ref, verification_status, meta)
       VALUES ${placeholders.join(",")}
       RETURNING *`,
      values
    );

    return res.json({
      success: true,
      inserted: result.rows.length,
      prospects: result.rows
    });

  } catch (err) {
    console.error("POST /api/prospects error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/prospects
 * Canonical prospect list: persons with prospect_intents, joined with affiliations
 * Filters: search, intent_type
 * Pagination: page, limit
 */
router.get('/api/prospects', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;

    const { search, intent_type } = req.query;

    let where = ['pi.organizer_id = $1'];
    const params = [organizerId];
    let idx = 2;

    if (intent_type) {
      where.push(`pi.intent_type = $${idx}`);
      params.push(intent_type);
      idx++;
    }

    if (search) {
      where.push(`(
        p.email ILIKE $${idx} OR
        p.first_name ILIKE $${idx} OR
        p.last_name ILIKE $${idx} OR
        a.company_name ILIKE $${idx} OR
        c.name ILIKE $${idx}
      )`);
      params.push(`%${search}%`);
      idx++;
    }

    const whereClause = where.join(' AND ');

    const countRes = await db.query(
      `SELECT COUNT(*) FROM prospect_intents pi
       JOIN persons p ON p.id = pi.person_id
       LEFT JOIN affiliations a ON a.person_id = p.id AND a.organizer_id = pi.organizer_id
       LEFT JOIN campaigns c ON c.id = pi.campaign_id
       WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const dataRes = await db.query(
      `SELECT
         pi.id,
         pi.person_id,
         p.email,
         p.first_name,
         p.last_name,
         a.company_name,
         a.job_title,
         pi.intent_type,
         pi.campaign_id,
         c.name AS campaign_name,
         pi.source,
         pi.confidence,
         pi.occurred_at,
         pi.created_at
       FROM prospect_intents pi
       JOIN persons p ON p.id = pi.person_id
       LEFT JOIN LATERAL (
         SELECT company_name, job_title FROM affiliations
         WHERE person_id = p.id AND organizer_id = pi.organizer_id
         ORDER BY is_primary DESC NULLS LAST, created_at DESC
         LIMIT 1
       ) a ON true
       LEFT JOIN campaigns c ON c.id = pi.campaign_id
       WHERE ${whereClause}
       ORDER BY pi.occurred_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    );

    // Stats summary
    const statsRes = await db.query(
      `SELECT
         COUNT(DISTINCT pi.person_id)::int AS total_prospects,
         COUNT(*)::int AS total_signals,
         COUNT(*) FILTER (WHERE pi.intent_type = 'reply')::int AS replies,
         COUNT(*) FILTER (WHERE pi.intent_type = 'click_through')::int AS clicks
       FROM prospect_intents pi
       WHERE pi.organizer_id = $1`,
      [organizerId]
    );

    res.json({
      total,
      page,
      limit,
      stats: statsRes.rows[0],
      prospects: dataRes.rows
    });

  } catch (err) {
    console.error("GET /api/prospects error:", err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
