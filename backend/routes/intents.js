const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

function authRequired(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No token" });
  const token = authHeader.replace("Bearer ", "").trim();
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

const VALID_INTENT_TYPES = [
  'reply', 'form_submission', 'manual_qualification',
  'meeting_booked', 'inbound_request', 'click_through', 'referral'
];

// GET /api/intents — List all intent signals (paginated, filterable)
router.get('/', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;

    const { intent_type, campaign_id, person_id, source } = req.query;

    let where = ['pi.organizer_id = $1'];
    const params = [organizerId];
    let idx = 2;

    if (intent_type && VALID_INTENT_TYPES.includes(intent_type)) {
      where.push(`pi.intent_type = $${idx}`);
      params.push(intent_type);
      idx++;
    }

    if (campaign_id) {
      where.push(`pi.campaign_id = $${idx}`);
      params.push(campaign_id);
      idx++;
    }

    if (person_id) {
      where.push(`pi.person_id = $${idx}`);
      params.push(person_id);
      idx++;
    }

    if (source && ['webhook', 'manual', 'api', 'automation'].includes(source)) {
      where.push(`pi.source = $${idx}`);
      params.push(source);
      idx++;
    }

    const whereClause = where.join(' AND ');

    const countRes = await db.query(
      `SELECT COUNT(*) FROM prospect_intents pi WHERE ${whereClause}`,
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
         pi.intent_type,
         pi.campaign_id,
         c.name AS campaign_name,
         pi.source,
         pi.notes,
         pi.confidence,
         pi.occurred_at,
         pi.created_at
       FROM prospect_intents pi
       JOIN persons p ON p.id = pi.person_id
       LEFT JOIN campaigns c ON c.id = pi.campaign_id
       WHERE ${whereClause}
       ORDER BY pi.occurred_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    );

    res.json({
      total,
      page,
      limit,
      intents: dataRes.rows
    });
  } catch (err) {
    console.error('GET /api/intents error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/intents/stats — Intent summary counts
router.get('/stats', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;

    const statsRes = await db.query(
      `SELECT
         intent_type,
         COUNT(*) AS count,
         COUNT(DISTINCT person_id) AS unique_persons,
         MAX(occurred_at) AS last_at
       FROM prospect_intents
       WHERE organizer_id = $1
       GROUP BY intent_type
       ORDER BY count DESC`,
      [organizerId]
    );

    const totalPersonsRes = await db.query(
      `SELECT COUNT(DISTINCT person_id) AS total
       FROM prospect_intents
       WHERE organizer_id = $1`,
      [organizerId]
    );

    res.json({
      total_persons_with_intent: parseInt(totalPersonsRes.rows[0].total, 10) || 0,
      by_type: statsRes.rows.map(r => ({
        intent_type: r.intent_type,
        count: parseInt(r.count, 10),
        unique_persons: parseInt(r.unique_persons, 10),
        last_at: r.last_at
      }))
    });
  } catch (err) {
    console.error('GET /api/intents/stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/intents — Manually create an intent signal
router.post('/', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const userId = req.auth.user_id || null;
    const { person_id, intent_type, campaign_id, notes, confidence } = req.body;

    if (!person_id) {
      return res.status(400).json({ error: 'person_id is required' });
    }

    if (!intent_type || !VALID_INTENT_TYPES.includes(intent_type)) {
      return res.status(400).json({ error: `intent_type must be one of: ${VALID_INTENT_TYPES.join(', ')}` });
    }

    // Verify person exists and belongs to organizer
    const personRes = await db.query(
      `SELECT id FROM persons WHERE id = $1 AND organizer_id = $2`,
      [person_id, organizerId]
    );

    if (personRes.rows.length === 0) {
      return res.status(404).json({ error: 'Person not found' });
    }

    // Validate confidence if provided
    let parsedConfidence = null;
    if (confidence !== undefined && confidence !== null) {
      parsedConfidence = parseFloat(confidence);
      if (isNaN(parsedConfidence) || parsedConfidence < 0 || parsedConfidence > 1) {
        return res.status(400).json({ error: 'confidence must be between 0 and 1' });
      }
    }

    const insertRes = await db.query(
      `INSERT INTO prospect_intents
         (organizer_id, person_id, campaign_id, intent_type, source, notes, confidence, created_by_user_id)
       VALUES ($1, $2, $3, $4, 'manual', $5, $6, $7)
       RETURNING id, intent_type, source, notes, confidence, occurred_at, created_at`,
      [organizerId, person_id, campaign_id || null, intent_type, notes || null, parsedConfidence, userId]
    );

    res.status(201).json({ intent: insertRes.rows[0] });
  } catch (err) {
    console.error('POST /api/intents error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/intents/:id — Delete an intent signal
router.delete('/:id', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const intentId = req.params.id;

    const deleteRes = await db.query(
      `DELETE FROM prospect_intents WHERE id = $1 AND organizer_id = $2 RETURNING id`,
      [intentId, organizerId]
    );

    if (deleteRes.rows.length === 0) {
      return res.status(404).json({ error: 'Intent not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/intents/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
