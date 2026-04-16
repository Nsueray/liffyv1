/**
 * sequences.js — Campaign sequence step CRUD + control + analytics.
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');
const { getUserContext, isPrivileged, canAccessRow } = require('../middleware/userScope');
const {
  initializeSequence,
  pauseSequence,
  resumeSequence,
  getSequenceAnalytics
} = require('../services/sequenceService');

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

async function authRequired(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing Authorization header' });
    const token = authHeader.replace('Bearer ', '').trim();
    const payload = jwt.verify(token, JWT_SECRET);
    let team_ids = [];
    if (payload.role === 'manager') {
      try {
        const t = await db.query(`SELECT id FROM users WHERE manager_id = $1 AND organizer_id = $2`, [payload.user_id, payload.organizer_id]);
        team_ids = t.rows.map(r => r.id);
      } catch (_) { /* migration pending */ }
    }
    req.auth = {
      user_id: payload.user_id,
      organizer_id: payload.organizer_id,
      role: payload.role,
      team_ids
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Middleware: load campaign and verify ownership
async function loadOwnedCampaign(req, res, next) {
  try {
    const organizerId = req.auth.organizer_id;
    const campaignId = req.params.id;

    const result = await db.query(
      `SELECT id, name, status, campaign_type, created_by_user_id
       FROM campaigns WHERE id = $1 AND organizer_id = $2`,
      [campaignId, organizerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = result.rows[0];

    // User isolation: non-privileged users can only manage campaigns they own or their team's
    if (campaign.created_by_user_id && !canAccessRow(req, campaign.created_by_user_id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    req.campaign = campaign;
    next();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// =========================================================================
// SEQUENCE STEP CRUD
// =========================================================================

// GET /api/campaigns/:id/sequences — list steps
router.get('/api/campaigns/:id/sequences', authRequired, loadOwnedCampaign, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT cs.id, cs.sequence_order, cs.template_id, cs.delay_days, cs.condition,
              cs.subject_override, cs.is_active, cs.created_at,
              t.name AS template_name, t.subject AS template_subject
       FROM campaign_sequences cs
       JOIN email_templates t ON t.id = cs.template_id
       WHERE cs.campaign_id = $1 AND cs.organizer_id = $2
       ORDER BY cs.sequence_order ASC`,
      [req.params.id, req.auth.organizer_id]
    );

    res.json({ steps: result.rows });
  } catch (err) {
    console.error('GET sequences error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/sequences — add step
router.post('/api/campaigns/:id/sequences', authRequired, loadOwnedCampaign, async (req, res) => {
  try {
    const { template_id, delay_days, condition, sequence_order, subject_override } = req.body;

    if (!template_id) return res.status(400).json({ error: 'template_id is required' });

    // Validate template exists and belongs to organizer
    const tplCheck = await db.query(
      `SELECT id FROM email_templates WHERE id = $1 AND organizer_id = $2`,
      [template_id, req.auth.organizer_id]
    );
    if (tplCheck.rows.length === 0) return res.status(404).json({ error: 'Template not found' });

    // Auto-assign sequence_order if not provided
    let order = sequence_order;
    if (!order) {
      const maxRes = await db.query(
        `SELECT COALESCE(MAX(sequence_order), 0) + 1 AS next_order
         FROM campaign_sequences WHERE campaign_id = $1`,
        [req.params.id]
      );
      order = parseInt(maxRes.rows[0].next_order, 10);
    }

    const validConditions = ['no_reply', 'no_open', 'always'];
    const cond = validConditions.includes(condition) ? condition : 'no_reply';

    const result = await db.query(
      `INSERT INTO campaign_sequences
         (organizer_id, campaign_id, sequence_order, template_id, delay_days, condition, subject_override)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        req.auth.organizer_id, req.params.id, order,
        template_id, delay_days || 0, cond, subject_override || null
      ]
    );

    // Fetch template name for response
    const step = result.rows[0];
    const tpl = tplCheck.rows[0];
    const tplName = await db.query(`SELECT name, subject FROM email_templates WHERE id = $1`, [template_id]);
    step.template_name = tplName.rows[0]?.name;
    step.template_subject = tplName.rows[0]?.subject;

    res.status(201).json(step);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Step order already exists for this campaign' });
    }
    console.error('POST sequence step error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/campaigns/:id/sequences/:stepId — update step
router.patch('/api/campaigns/:id/sequences/:stepId', authRequired, loadOwnedCampaign, async (req, res) => {
  try {
    const { template_id, delay_days, condition, subject_override, is_active } = req.body;

    const existing = await db.query(
      `SELECT id FROM campaign_sequences WHERE id = $1 AND campaign_id = $2 AND organizer_id = $3`,
      [req.params.stepId, req.params.id, req.auth.organizer_id]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Step not found' });

    // Build dynamic UPDATE
    const sets = [];
    const params = [];
    let idx = 1;

    if (template_id !== undefined) { sets.push(`template_id = $${idx++}`); params.push(template_id); }
    if (delay_days !== undefined) { sets.push(`delay_days = $${idx++}`); params.push(delay_days); }
    if (condition !== undefined) { sets.push(`condition = $${idx++}`); params.push(condition); }
    if (subject_override !== undefined) { sets.push(`subject_override = $${idx++}`); params.push(subject_override || null); }
    if (is_active !== undefined) { sets.push(`is_active = $${idx++}`); params.push(is_active); }

    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.stepId);
    const result = await db.query(
      `UPDATE campaign_sequences SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH sequence step error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/campaigns/:id/sequences/:stepId — delete step
router.delete('/api/campaigns/:id/sequences/:stepId', authRequired, loadOwnedCampaign, async (req, res) => {
  try {
    const result = await db.query(
      `DELETE FROM campaign_sequences
       WHERE id = $1 AND campaign_id = $2 AND organizer_id = $3
       RETURNING id`,
      [req.params.stepId, req.params.id, req.auth.organizer_id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Step not found' });

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE sequence step error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/sequences/reorder — reorder steps
router.post('/api/campaigns/:id/sequences/reorder', authRequired, loadOwnedCampaign, async (req, res) => {
  try {
    const { steps } = req.body; // [{ id, sequence_order }]
    if (!Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ error: 'steps array is required' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Temporarily set all to negative to avoid unique constraint violations
      for (const s of steps) {
        await client.query(
          `UPDATE campaign_sequences SET sequence_order = -1 * $3
           WHERE id = $1 AND campaign_id = $2 AND organizer_id = $4`,
          [s.id, req.params.id, s.sequence_order, req.auth.organizer_id]
        );
      }

      // Set final values
      for (const s of steps) {
        await client.query(
          `UPDATE campaign_sequences SET sequence_order = $3
           WHERE id = $1 AND campaign_id = $2 AND organizer_id = $4`,
          [s.id, req.params.id, s.sequence_order, req.auth.organizer_id]
        );
      }

      await client.query('COMMIT');
      res.json({ success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('POST sequences reorder error:', err);
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// SEQUENCE CONTROL
// =========================================================================

// POST /api/campaigns/:id/start-sequence — initialize and start sequence
router.post('/api/campaigns/:id/start-sequence', authRequired, loadOwnedCampaign, async (req, res) => {
  try {
    const campaign = req.campaign;

    if (!['draft', 'ready'].includes(campaign.status)) {
      return res.status(400).json({
        error: `Cannot start sequence: campaign status is '${campaign.status}', expected 'draft' or 'ready'`
      });
    }

    const result = await initializeSequence(req.params.id, req.auth.organizer_id);
    res.json(result);
  } catch (err) {
    console.error('POST start-sequence error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/pause-sequence
router.post('/api/campaigns/:id/pause-sequence', authRequired, loadOwnedCampaign, async (req, res) => {
  try {
    if (req.campaign.status !== 'sending') {
      return res.status(400).json({ error: 'Campaign is not currently sending' });
    }
    const result = await pauseSequence(req.params.id, req.auth.organizer_id);
    res.json(result);
  } catch (err) {
    console.error('POST pause-sequence error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/resume-sequence
router.post('/api/campaigns/:id/resume-sequence', authRequired, loadOwnedCampaign, async (req, res) => {
  try {
    if (req.campaign.status !== 'paused') {
      return res.status(400).json({ error: 'Campaign is not paused' });
    }
    const result = await resumeSequence(req.params.id, req.auth.organizer_id);
    res.json(result);
  } catch (err) {
    console.error('POST resume-sequence error:', err);
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// SEQUENCE ANALYTICS
// =========================================================================

// GET /api/campaigns/:id/sequence-analytics
router.get('/api/campaigns/:id/sequence-analytics', authRequired, loadOwnedCampaign, async (req, res) => {
  try {
    const analytics = await getSequenceAnalytics(req.params.id, req.auth.organizer_id);
    res.json(analytics);
  } catch (err) {
    console.error('GET sequence-analytics error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
