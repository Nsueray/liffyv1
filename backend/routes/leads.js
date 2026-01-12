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
        tags,
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
      leads: dataResult.rows.map(row => ({
        ...row,
        tags: row.tags || []
      }))
    });
  } catch (err) {
    console.error('GET /api/leads error:', err);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

router.post('/:id/tags', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const leadId = req.params.id;
    const { tags } = req.body;

    const checkResult = await db.query(
      'SELECT id FROM prospects WHERE id = $1 AND organizer_id = $2',
      [leadId, organizerId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    let normalizedTags = [];
    if (Array.isArray(tags)) {
      normalizedTags = tags
        .map(t => (typeof t === 'string' ? t.trim().toLowerCase() : ''))
        .filter(t => t.length > 0);
    }

    const updateResult = await db.query(
      'UPDATE prospects SET tags = $1 WHERE id = $2 RETURNING id, tags',
      [normalizedTags, leadId]
    );

    res.json({
      id: updateResult.rows[0].id,
      tags: updateResult.rows[0].tags || []
    });
  } catch (err) {
    console.error('POST /api/leads/:id/tags error:', err);
    res.status(500).json({ error: 'Failed to update tags' });
  }
});

router.post('/bulk-tags', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const { lead_ids, tags } = req.body;

    if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
      return res.status(400).json({ error: 'lead_ids array is required' });
    }

    if (!Array.isArray(tags)) {
      return res.status(400).json({ error: 'tags array is required' });
    }

    const normalizedTags = tags
      .map(t => (typeof t === 'string' ? t.trim().toLowerCase() : ''))
      .filter(t => t.length > 0);

    if (normalizedTags.length === 0) {
      return res.status(400).json({ error: 'At least one valid tag is required' });
    }

    const verifyResult = await db.query(
      'SELECT id FROM prospects WHERE id = ANY($1) AND organizer_id = $2',
      [lead_ids, organizerId]
    );

    const validIds = verifyResult.rows.map(r => r.id);

    if (validIds.length === 0) {
      return res.status(404).json({ error: 'No valid leads found' });
    }

    const updateResult = await db.query(
      `
      UPDATE prospects 
      SET tags = (
        SELECT ARRAY(
          SELECT DISTINCT unnest(COALESCE(tags, '{}') || $1::text[])
        )
      )
      WHERE id = ANY($2) AND organizer_id = $3
      RETURNING id, tags
      `,
      [normalizedTags, validIds, organizerId]
    );

    res.json({
      updated_count: updateResult.rows.length,
      leads: updateResult.rows.map(r => ({
        id: r.id,
        tags: r.tags || []
      }))
    });
  } catch (err) {
    console.error('POST /api/leads/bulk-tags error:', err);
    res.status(500).json({ error: 'Failed to update tags' });
  }
});

module.exports = router;
