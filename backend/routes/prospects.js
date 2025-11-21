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
 * Filters: email, country, sector, verification_status, list_id
 */
router.get('/api/prospects', authRequired, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;
    const { email, country, sector, verification_status, list_id } = req.query;

    let query = `
      SELECT p.*
      FROM prospects p
    `;
    const where = [`p.organizer_id = $1`];
    const params = [organizer_id];
    let idx = 2;

    if (list_id) {
      query += `
        JOIN list_members lm 
          ON lm.prospect_id = p.id 
         AND lm.list_id = $${idx}
      `;
      params.push(list_id);
      idx++;
    }

    if (email) {
      where.push(`p.email ILIKE $${idx}`);
      params.push(`%${email}%`);
      idx++;
    }

    if (country) {
      where.push(`p.country = $${idx}`);
      params.push(country);
      idx++;
    }

    if (sector) {
      where.push(`p.sector = $${idx}`);
      params.push(sector);
      idx++;
    }

    if (verification_status) {
      where.push(`p.verification_status = $${idx}`);
      params.push(verification_status);
      idx++;
    }

    query += ` WHERE ${where.join(" AND ")} ORDER BY p.created_at DESC`;

    const result = await db.query(query, params);

    return res.json({
      success: true,
      prospects: result.rows
    });

  } catch (err) {
    console.error("GET /api/prospects error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/lists
 * Create a new list
 */
router.post('/api/lists', authRequired, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;
    const user_id = req.auth.user_id;

    const { name, description, type } = req.body;

    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const result = await db.query(
      `INSERT INTO lists 
       (organizer_id, name, description, type, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [organizer_id, name, description || null, type || 'manual', user_id]
    );

    return res.json({
      success: true,
      list: result.rows[0]
    });

  } catch (err) {
    console.error("POST /api/lists error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/lists
 * List all lists for organizer
 */
router.get('/api/lists', authRequired, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;

    const result = await db.query(
      `SELECT * 
       FROM lists
       WHERE organizer_id = $1
       ORDER BY created_at DESC`,
      [organizer_id]
    );

    return res.json({
      success: true,
      lists: result.rows
    });

  } catch (err) {
    console.error("GET /api/lists error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/lists/:id/add
 * Add one or more prospects to list
 */
router.post('/api/lists/:id/add', authRequired, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;
    const list_id = req.params.id;
    let { prospect_ids } = req.body;

    if (!prospect_ids) {
      return res.status(400).json({ error: "prospect_ids required" });
    }
    if (!Array.isArray(prospect_ids)) {
      prospect_ids = [prospect_ids];
    }

    const values = [];
    const placeholders = [];

    prospect_ids.forEach((pid, i) => {
      const idx = i * 3;
      values.push(organizer_id, list_id, pid);
      placeholders.push(`($${idx + 1}, $${idx + 2}, $${idx + 3})`);
    });

    const result = await db.query(
      `INSERT INTO list_members (organizer_id, list_id, prospect_id)
       VALUES ${placeholders.join(",")}
       ON CONFLICT DO NOTHING
       RETURNING *`,
      values
    );

    return res.json({
      success: true,
      added: result.rows.length
    });

  } catch (err) {
    console.error("POST /api/lists/:id/add error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/lists/:id/members
 * List all prospects in a list
 */
router.get('/api/lists/:id/members', authRequired, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;
    const list_id = req.params.id;

    const result = await db.query(
      `SELECT p.*
       FROM list_members lm
       JOIN prospects p ON lm.prospect_id = p.id
       WHERE lm.list_id = $1
         AND lm.organizer_id = $2
       ORDER BY p.created_at DESC`,
      [list_id, organizer_id]
    );

    return res.json({
      success: true,
      prospects: result.rows
    });

  } catch (err) {
    console.error("GET /api/lists/:id/members error:", err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
