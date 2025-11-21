const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

/**
 * Middleware: validate JWT and attach req.auth
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
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * POST /api/campaigns/:id/recipients
 * Add one or multiple recipients to a campaign
 */
router.post('/api/campaigns/:id/recipients', authRequired, async (req, res) => {
  try {
    const campaign_id = req.params.id;
    const organizer_id = req.auth.organizer_id;
    let { recipients } = req.body;

    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: "recipients array required" });
    }

    const values = [];
    const placeholders = [];

    recipients.forEach((r, idx) => {
      const email = r.email;
      const name = r.name || null;
      const meta = r.meta || null;

      if (!email) return;

      values.push(organizer_id, campaign_id, email, name, meta);
      const baseIndex = idx * 5;

      placeholders.push(
        `($${baseIndex+1}, $${baseIndex+2}, $${baseIndex+3}, $${baseIndex+4}, $${baseIndex+5})`
      );
    });

    if (values.length === 0) {
      return res.status(400).json({ error: "No valid recipients found" });
    }

    const query = `
      INSERT INTO campaign_recipients
      (organizer_id, campaign_id, email, name, meta)
      VALUES ${placeholders.join(",")}
      RETURNING *;
    `;

    const result = await db.query(query, values);

    return res.json({
      success: true,
      inserted: result.rows.length,
      recipients: result.rows
    });

  } catch (err) {
    console.error("POST /campaign recipients error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/campaigns/:id/recipients
 * List all recipients
 */
router.get('/api/campaigns/:id/recipients', authRequired, async (req, res) => {
  try {
    const campaign_id = req.params.id;
    const organizer_id = req.auth.organizer_id;

    const result = await db.query(
      `SELECT *
       FROM campaign_recipients
       WHERE campaign_id = $1 AND organizer_id = $2
       ORDER BY created_at ASC`,
      [campaign_id, organizer_id]
    );

    return res.json({
      success: true,
      recipients: result.rows
    });

  } catch (err) {
    console.error("GET /campaign recipients error:", err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
