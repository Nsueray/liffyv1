const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

async function authRequired(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "Missing Authorization header" });
    }

    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) {
      return res.status(401).json({ error: "Invalid token format" });
    }

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
 * GET /api/senders
 * List all active sender identities for current organizer
 */
router.get('/api/senders', authRequired, async (req, res) => {
  try {
    const { organizer_id } = req.auth;

    const result = await db.query(
      `SELECT 
         id,
         organizer_id,
         user_id,
         label,
         from_name,
         from_email,
         reply_to,
         is_default,
         is_active,
         created_at
       FROM sender_identities
       WHERE organizer_id = $1 AND is_active = true
       ORDER BY is_default DESC, created_at DESC`,
      [organizer_id]
    );

    // Map to expected format for frontend
    const identities = result.rows.map(row => ({
      id: row.id,
      name: row.from_name || row.label || 'Unnamed',
      email: row.from_email,
      label: row.label,
      from_name: row.from_name,
      reply_to: row.reply_to,
      is_default: row.is_default,
      is_active: row.is_active,
      created_at: row.created_at
    }));

    return res.json({
      success: true,
      identities: identities,  // Frontend expects this
      items: identities        // Keep for backward compatibility
    });

  } catch (err) {
    console.error("GET /api/senders error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/senders
 * Create new sender identity
 */
router.post('/api/senders', authRequired, async (req, res) => {
  try {
    const { organizer_id, user_id } = req.auth;
    const { label, from_name, from_email, reply_to, is_default } = req.body;

    if (!from_name || !from_email) {
      return res.status(400).json({ error: "from_name and from_email are required" });
    }

    // If this should be default, reset other defaults
    if (is_default === true) {
      await db.query(
        `UPDATE sender_identities 
         SET is_default = false 
         WHERE organizer_id = $1`,
        [organizer_id]
      );
    }

    const insertResult = await db.query(
      `INSERT INTO sender_identities
       (organizer_id, user_id, label, from_name, from_email, reply_to, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        organizer_id,
        user_id,
        label || null,
        from_name,
        from_email,
        reply_to || null,
        is_default === true
      ]
    );

    const row = insertResult.rows[0];

    return res.json({
      success: true,
      sender: {
        id: row.id,
        name: row.from_name || row.label,
        email: row.from_email,
        label: row.label,
        from_name: row.from_name,
        reply_to: row.reply_to,
        is_default: row.is_default,
        is_active: row.is_active,
        created_at: row.created_at
      }
    });

  } catch (err) {
    console.error("POST /api/senders error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/senders/:id
 * Soft delete (set is_active = false)
 */
router.delete('/api/senders/:id', authRequired, async (req, res) => {
  try {
    const { organizer_id } = req.auth;
    const { id } = req.params;

    const result = await db.query(
      `UPDATE sender_identities 
       SET is_active = false 
       WHERE id = $1 AND organizer_id = $2
       RETURNING id`,
      [id, organizer_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Sender not found" });
    }

    return res.json({ success: true, deleted: id });

  } catch (err) {
    console.error("DELETE /api/senders error:", err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
