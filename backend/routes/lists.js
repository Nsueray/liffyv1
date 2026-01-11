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

// GET /api/lists - Get all lists for organizer with counts
router.get('/', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;

    const result = await db.query(
      `
      SELECT 
        l.id,
        l.name,
        l.created_at,
        COUNT(lm.id) AS total_leads,
        COUNT(CASE WHEN p.verification_status = 'valid' THEN 1 END) AS verified_count,
        COUNT(CASE WHEN p.verification_status IS NULL OR p.verification_status != 'valid' THEN 1 END) AS unverified_count
      FROM lists l
      LEFT JOIN list_members lm ON lm.list_id = l.id
      LEFT JOIN prospects p ON p.id = lm.prospect_id
      WHERE l.organizer_id = $1
      GROUP BY l.id, l.name, l.created_at
      ORDER BY l.created_at DESC
      `,
      [organizerId]
    );

    res.json({
      lists: result.rows.map(row => ({
        id: row.id,
        name: row.name,
        created_at: row.created_at,
        total_leads: parseInt(row.total_leads, 10),
        verified_count: parseInt(row.verified_count, 10),
        unverified_count: parseInt(row.unverified_count, 10)
      }))
    });
  } catch (err) {
    console.error('GET /api/lists error:', err);
    res.status(500).json({ error: 'Failed to fetch lists' });
  }
});

// POST /api/lists - Create new list
router.post('/', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'List name is required' });
    }

    const trimmedName = name.trim();

    // Check for duplicate name within organizer
    const existing = await db.query(
      'SELECT id FROM lists WHERE organizer_id = $1 AND LOWER(name) = LOWER($2)',
      [organizerId, trimmedName]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'A list with this name already exists' });
    }

    const result = await db.query(
      'INSERT INTO lists (organizer_id, name) VALUES ($1, $2) RETURNING id, name, created_at',
      [organizerId, trimmedName]
    );

    const newList = result.rows[0];

    res.status(201).json({
      id: newList.id,
      name: newList.name,
      created_at: newList.created_at,
      total_leads: 0,
      verified_count: 0,
      unverified_count: 0
    });
  } catch (err) {
    console.error('POST /api/lists error:', err);
    res.status(500).json({ error: 'Failed to create list' });
  }
});

// DELETE /api/lists/:id - Delete list and cascade members
router.delete('/:id', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const listId = req.params.id;

    // Verify ownership
    const listCheck = await db.query(
      'SELECT id FROM lists WHERE id = $1 AND organizer_id = $2',
      [listId, organizerId]
    );

    if (listCheck.rows.length === 0) {
      return res.status(404).json({ error: 'List not found' });
    }

    // Delete list members first (cascade)
    await db.query('DELETE FROM list_members WHERE list_id = $1', [listId]);

    // Delete the list
    await db.query('DELETE FROM lists WHERE id = $1', [listId]);

    res.json({ success: true, deleted_id: listId });
  } catch (err) {
    console.error('DELETE /api/lists/:id error:', err);
    res.status(500).json({ error: 'Failed to delete list' });
  }
});

module.exports = router;
