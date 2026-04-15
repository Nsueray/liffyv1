/**
 * timeline.js — Chronological activity timeline for a person (Blueprint Section 9).
 *
 * Merges campaign_events + contact_notes + contact_activities into a single
 * time-ordered stream for the Contact Drawer.
 *
 * GET /api/timeline/:personId
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

function authRequired(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Missing Authorization header" });
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

router.get('/:personId', authRequired, async (req, res) => {
  try {
    const { organizer_id } = req.auth;
    const { personId } = req.params;

    const result = await db.query(
      `(
        SELECT
          ce.occurred_at AS timestamp,
          ce.event_type AS activity_type,
          'email' AS channel,
          c.name AS campaign_name,
          ce.url AS link_clicked,
          ce.reason AS detail,
          NULL AS user_name,
          ce.email
        FROM campaign_events ce
        LEFT JOIN campaigns c ON c.id = ce.campaign_id
        WHERE ce.person_id = $1 AND ce.organizer_id = $2
      )
      UNION ALL
      (
        SELECT
          cn.created_at AS timestamp,
          'note_added' AS activity_type,
          'manual' AS channel,
          NULL AS campaign_name,
          NULL AS link_clicked,
          cn.content AS detail,
          COALESCE(u.first_name || ' ' || u.last_name, u.email) AS user_name,
          NULL AS email
        FROM contact_notes cn
        LEFT JOIN users u ON u.id = cn.user_id
        WHERE cn.person_id = $1 AND cn.organizer_id = $2
      )
      UNION ALL
      (
        SELECT
          ca.occurred_at AS timestamp,
          ca.activity_type,
          'system' AS channel,
          NULL AS campaign_name,
          NULL AS link_clicked,
          ca.description AS detail,
          COALESCE(u.first_name || ' ' || u.last_name, u.email) AS user_name,
          NULL AS email
        FROM contact_activities ca
        LEFT JOIN users u ON u.id = ca.user_id
        WHERE ca.person_id = $1 AND ca.organizer_id = $2
      )
      ORDER BY timestamp DESC
      LIMIT 100`,
      [personId, organizer_id]
    );

    res.json({ timeline: result.rows });
  } catch (err) {
    console.error('[Timeline] GET /:personId error:', err.message);
    res.status(500).json({ error: 'Failed to fetch timeline' });
  }
});

module.exports = router;
