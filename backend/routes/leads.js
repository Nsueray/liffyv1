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

// GET /api/leads
router.get('/', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 500;
    const offset = (page - 1) * limit;

    const search = req.query.search || '';
    const verificationStatus = req.query.verification_status || '';
    const country = req.query.country || '';

    let conditions = ['organizer_id = $1'];
    let params = [organizerId];
    let paramIndex = 2;

    if (search.trim()) {
      conditions.push(`(
        LOWER(email) LIKE LOWER($${paramIndex}) OR
        LOWER(name) LIKE LOWER($${paramIndex}) OR
        LOWER(company) LIKE LOWER($${paramIndex})
      )`);
      params.push(`%${search.trim()}%`);
      paramIndex++;
    }

    if (verificationStatus.trim()) {
      conditions.push(`verification_status = $${paramIndex}`);
      params.push(verificationStatus.trim());
      paramIndex++;
    }

    if (country.trim()) {
      conditions.push(`LOWER(country) LIKE LOWER($${paramIndex})`);
      params.push(`%${country.trim()}%`);
      paramIndex++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await db.query(
      `SELECT COUNT(*) FROM prospects ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const dataResult = await db.query(
      `
      SELECT
        id,
        email,
        name,
        company,
        country,
        verification_status,
        source_type,
        source_ref,
        created_at
      FROM prospects
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `,
      [...params, limit, offset]
    );

    res.json({
      page,
      limit,
      total,
      leads: dataResult.rows
    });
  } catch (err) {
    console.error('GET /api/leads error:', err);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

module.exports = router;
