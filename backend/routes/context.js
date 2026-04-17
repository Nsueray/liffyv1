/**
 * context.js — Context cards for a person (Blueprint Section 8 Contact Drawer).
 *
 * Generates summary cards from existing data: company info, engagement,
 * campaign history, mining source.
 *
 * GET /api/context/:personId
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
    payload.user_id = payload.user_id || payload.id; // normalize legacy JWT
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
    const cards = [];

    // 1. Company info — primary affiliation
    const affRes = await db.query(
      `SELECT company_name, position, country_code, city, website
       FROM affiliations
       WHERE person_id = $1 AND organizer_id = $2
         AND company_name IS NOT NULL AND company_name NOT LIKE '%@%'
       ORDER BY created_at DESC NULLS LAST
       LIMIT 1`,
      [personId, organizer_id]
    );
    if (affRes.rows.length > 0) {
      const a = affRes.rows[0];
      const parts = [a.company_name];
      if (a.country_code) parts.push(a.country_code);
      if (a.position) parts.push(a.position);
      cards.push({ type: 'company', icon: 'building', text: parts.join(' — ') });
    }

    // 2. Engagement summary
    const engRes = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE event_type = 'open') AS opens,
         COUNT(*) FILTER (WHERE event_type = 'click') AS clicks,
         COUNT(*) FILTER (WHERE event_type = 'reply') AS replies,
         COUNT(*) FILTER (WHERE event_type = 'bounce') AS bounces,
         MAX(occurred_at) AS last_activity
       FROM campaign_events
       WHERE person_id = $1 AND organizer_id = $2`,
      [personId, organizer_id]
    );
    if (engRes.rows.length > 0) {
      const e = engRes.rows[0];
      const opens = parseInt(e.opens, 10);
      const clicks = parseInt(e.clicks, 10);
      const replies = parseInt(e.replies, 10);
      const score = opens * 1 + clicks * 3 + replies * 10;
      if (score > 0) {
        const parts = [];
        if (opens) parts.push(`${opens} open${opens > 1 ? 's' : ''}`);
        if (clicks) parts.push(`${clicks} click${clicks > 1 ? 's' : ''}`);
        if (replies) parts.push(`${replies} repl${replies > 1 ? 'ies' : 'y'}`);
        cards.push({
          type: 'engagement',
          icon: 'activity',
          text: `Engagement Score: ${score} — ${parts.join(', ')}`
        });
      }
    }

    // 3. Campaign history
    const campRes = await db.query(
      `SELECT DISTINCT c.name
       FROM campaign_events ce
       JOIN campaigns c ON c.id = ce.campaign_id
       WHERE ce.person_id = $1 AND ce.organizer_id = $2 AND ce.event_type = 'sent'
       ORDER BY c.name
       LIMIT 5`,
      [personId, organizer_id]
    );
    if (campRes.rows.length > 0) {
      const names = campRes.rows.map(r => r.name).join(', ');
      cards.push({
        type: 'campaign',
        icon: 'mail',
        text: `${campRes.rows.length} campaign${campRes.rows.length > 1 ? 's' : ''} sent — ${names}`
      });
    }

    // 4. Mining source
    const srcRes = await db.query(
      `SELECT source_ref, source_type
       FROM affiliations
       WHERE person_id = $1 AND organizer_id = $2 AND source_ref IS NOT NULL
       ORDER BY created_at ASC
       LIMIT 1`,
      [personId, organizer_id]
    );
    if (srcRes.rows.length > 0) {
      const s = srcRes.rows[0];
      cards.push({
        type: 'source',
        icon: 'search',
        text: `Mined from: ${s.source_ref}`
      });
    }

    // 5. Pipeline stage (if assigned)
    const stageRes = await db.query(
      `SELECT ps.name AS stage_name
       FROM persons p
       JOIN pipeline_stages ps ON ps.id = p.pipeline_stage_id AND ps.organizer_id = $2
       WHERE p.id = $1 AND p.organizer_id = $2 AND p.pipeline_stage_id IS NOT NULL`,
      [personId, organizer_id]
    );
    if (stageRes.rows.length > 0) {
      cards.push({
        type: 'stage',
        icon: 'activity',
        text: `Pipeline: ${stageRes.rows[0].stage_name}`
      });
    }

    // 6. Email verification status
    const verRes = await db.query(
      `SELECT email, verification_status FROM persons
       WHERE id = $1 AND organizer_id = $2 AND verification_status IS NOT NULL
         AND verification_status NOT IN ('unknown', 'pending')`,
      [personId, organizer_id]
    );
    if (verRes.rows.length > 0) {
      const v = verRes.rows[0];
      const emoji = v.verification_status === 'valid' ? 'Valid' : v.verification_status === 'invalid' ? 'Invalid' : v.verification_status;
      cards.push({
        type: 'verification',
        icon: 'mail',
        text: `Email: ${emoji}`
      });
    }

    res.json({ cards });
  } catch (err) {
    console.error('[Context] GET /:personId error:', err.message);
    res.status(500).json({ error: 'Failed to fetch context cards' });
  }
});

module.exports = router;
