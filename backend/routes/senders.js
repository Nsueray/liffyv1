const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');
const { getUserContext, isPrivileged, getUpwardVisibilityScope, canAccessRowHierarchical } = require('../middleware/userScope');

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
    payload.user_id = payload.user_id || payload.id; // normalize legacy JWT
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
 * List all active sender identities for current organizer (visibility-filtered)
 */
router.get('/api/senders', authRequired, async (req, res) => {
  try {
    const { organizer_id } = req.auth;
    const scope = getUpwardVisibilityScope(req, 'user_id', 'visibility', 2);

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
         visibility,
         created_at
       FROM sender_identities
       WHERE organizer_id = $1 AND is_active = true ${scope.sql}
       ORDER BY is_default DESC, created_at DESC`,
      [organizer_id, ...scope.params]
    );

    // Get campaign usage counts per sender
    const usageRes = await db.query(
      `SELECT sender_identity_id, COUNT(*)::int AS campaign_count
       FROM campaigns
       WHERE organizer_id = $1 AND sender_identity_id IS NOT NULL
       GROUP BY sender_identity_id`,
      [organizer_id]
    );
    const usageMap = Object.fromEntries(usageRes.rows.map(r => [r.sender_identity_id, r.campaign_count]));

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
      visibility: row.visibility || 'shared',
      user_id: row.user_id,
      created_at: row.created_at,
      campaign_count: usageMap[row.id] || 0
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
    const { label, from_name, from_email, reply_to, is_default, visibility } = req.body;

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

    const vis = (visibility === 'private') ? 'private' : 'shared';

    const insertResult = await db.query(
      `INSERT INTO sender_identities
       (organizer_id, user_id, label, from_name, from_email, reply_to, is_default, visibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        organizer_id,
        user_id,
        label || null,
        from_name,
        from_email,
        reply_to || null,
        is_default === true,
        vis
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
        visibility: row.visibility || 'shared',
        user_id: row.user_id,
        created_at: row.created_at
      }
    });

  } catch (err) {
    console.error("POST /api/senders error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/senders/:id
 * Update sender identity (from_name, reply_to, visibility, label)
 * from_email is NOT editable (requires SendGrid re-verification)
 */
router.put('/api/senders/:id', authRequired, async (req, res) => {
  try {
    const { organizer_id } = req.auth;
    const { id } = req.params;
    const { from_name, reply_to, visibility, label } = req.body;

    // Check existence + ownership
    const existing = await db.query(
      'SELECT id, user_id FROM sender_identities WHERE id = $1 AND organizer_id = $2 LIMIT 1',
      [id, organizer_id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Sender not found" });
    }

    const ownerId = existing.rows[0].user_id;
    if (ownerId && !(await canAccessRowHierarchical(req, ownerId))) {
      return res.status(403).json({ error: 'You can only edit your own sender identities' });
    }

    if (!from_name || !from_name.trim()) {
      return res.status(400).json({ error: 'from_name is required' });
    }

    const vis = (visibility === 'private') ? 'private' : 'shared';

    const result = await db.query(
      `UPDATE sender_identities
       SET from_name = $1, reply_to = $2, visibility = $3, label = $4
       WHERE id = $5 AND organizer_id = $6
       RETURNING *`,
      [from_name.trim(), reply_to || null, vis, label || null, id, organizer_id]
    );

    const row = result.rows[0];
    return res.json({
      success: true,
      sender: {
        id: row.id,
        name: row.from_name || row.label,
        email: row.from_email,
        label: row.label,
        from_name: row.from_name,
        from_email: row.from_email,
        reply_to: row.reply_to,
        is_default: row.is_default,
        is_active: row.is_active,
        visibility: row.visibility || 'shared',
        user_id: row.user_id,
        created_at: row.created_at
      }
    });
  } catch (err) {
    console.error("PUT /api/senders error:", err);
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

    // Check ownership
    const existing = await db.query(
      'SELECT id, user_id FROM sender_identities WHERE id = $1 AND organizer_id = $2 LIMIT 1',
      [id, organizer_id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Sender not found" });
    }

    const ownerId = existing.rows[0].user_id;
    if (ownerId && !(await canAccessRowHierarchical(req, ownerId))) {
      return res.status(403).json({ error: 'You can only delete your own sender identities' });
    }

    await db.query(
      `UPDATE sender_identities
       SET is_active = false
       WHERE id = $1 AND organizer_id = $2
       RETURNING id`,
      [id, organizer_id]
    );

    return res.json({ success: true, deleted: id });

  } catch (err) {
    console.error("DELETE /api/senders error:", err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
