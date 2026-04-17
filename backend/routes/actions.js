/**
 * actions.js — CRUD routes for Action Engine action items (Blueprint Section 8).
 *
 * Endpoints:
 *   GET    /api/actions          — list action items (user-scoped, with person JOIN)
 *   GET    /api/actions/summary  — counts by status/priority for badges
 *   PATCH  /api/actions/:id      — update status (done/dismissed/snoozed/in_progress)
 *   POST   /api/actions          — create manual_flag action item
 *   GET    /api/actions/history  — resolved items (done/dismissed) for audit
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');
const { getUserContext, isPrivileged, getHierarchicalScope } = require('../middleware/userScope');
const { upsertActionItem, computeEngagementScore, getFallbackOwner } = require('../engines/action-engine/actionEngine');

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

async function authRequired(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "Missing Authorization header" });
    }
    const token = authHeader.replace("Bearer ", "").trim();
    const payload = jwt.verify(token, JWT_SECRET);
    payload.user_id = payload.user_id || payload.id; // normalize legacy JWT
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
    console.error("Auth error:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ---------------------------------------------------------------------------
// GET /api/actions — list open/in_progress action items
// ---------------------------------------------------------------------------
router.get('/', authRequired, async (req, res) => {
  try {
    const { organizer_id, user_id, role } = req.auth;
    const { status, trigger_reason, sort, limit: rawLimit, offset: rawOffset } = req.query;

    const statusFilter = status || 'open,in_progress';
    const statuses = statusFilter.split(',').map(s => s.trim());

    let paramIdx = 2;
    const params = [organizer_id];

    // User scope: hierarchical (self + descendants via reports_to)
    const scope = getHierarchicalScope(req, 'ai.assigned_to', paramIdx);
    const userClause = scope.sql;
    params.push(...scope.params);
    paramIdx = scope.nextIndex;

    // Status filter
    const statusPlaceholders = statuses.map((_, i) => `$${paramIdx + i}`).join(',');
    params.push(...statuses);
    paramIdx += statuses.length;

    // Trigger filter
    let triggerClause = '';
    if (trigger_reason) {
      triggerClause = ` AND ai.trigger_reason = $${paramIdx}`;
      params.push(trigger_reason);
      paramIdx++;
    }

    // Sort
    let orderBy = 'ai.priority ASC, ai.last_activity_at DESC NULLS LAST';
    if (sort === 'recent') orderBy = 'ai.last_activity_at DESC NULLS LAST';
    else if (sort === 'company') orderBy = 'aff.company_name ASC NULLS LAST, ai.priority ASC';
    else if (sort === 'engagement') orderBy = 'ai.engagement_score DESC, ai.priority ASC';

    // Pagination
    const limit = Math.min(parseInt(rawLimit, 10) || 50, 200);
    const offset = parseInt(rawOffset, 10) || 0;

    const sql = `
      SELECT ai.*,
             p.email AS person_email,
             p.first_name AS person_first_name,
             p.last_name AS person_last_name,
             aff.company_name,
             aff.job_title,
             c.name AS campaign_name,
             COALESCE(u.first_name || ' ' || u.last_name, u.email) AS assigned_to_name
      FROM action_items ai
      LEFT JOIN persons p ON p.id = ai.person_id
      LEFT JOIN LATERAL (
        SELECT company_name, position AS job_title FROM affiliations
        WHERE person_id = ai.person_id AND organizer_id = ai.organizer_id
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1
      ) aff ON true
      LEFT JOIN campaigns c ON c.id = ai.campaign_id
      LEFT JOIN users u ON u.id = ai.assigned_to
      WHERE ai.organizer_id = $1
        ${userClause}
        AND ai.status IN (${statusPlaceholders})
        ${triggerClause}
      ORDER BY ${orderBy}
      LIMIT ${limit} OFFSET ${offset}`;

    const result = await db.query(sql, params);
    res.json({ items: result.rows, count: result.rows.length });
  } catch (err) {
    console.error('[Actions] GET / error:', err.message);
    res.status(500).json({ error: 'Failed to fetch action items' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/actions/summary — badge counts
// ---------------------------------------------------------------------------
router.get('/summary', authRequired, async (req, res) => {
  try {
    const { organizer_id, user_id, role } = req.auth;
    const params = [organizer_id];
    let paramIdx = 2;

    let userClause = '';
    const summaryScope = getHierarchicalScope(req, 'assigned_to', paramIdx);
    userClause = summaryScope.sql;
    params.push(...summaryScope.params);
    paramIdx = summaryScope.nextIndex;

    const result = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('open', 'in_progress')) AS total_open,
         COUNT(*) FILTER (WHERE status = 'open' AND priority = 1) AS p1_count,
         COUNT(*) FILTER (WHERE status = 'open' AND priority = 2) AS p2_count,
         COUNT(*) FILTER (WHERE status = 'open' AND priority = 3) AS p3_count,
         COUNT(*) FILTER (WHERE status = 'open' AND priority = 4) AS p4_count,
         COUNT(*) FILTER (WHERE status = 'snoozed') AS snoozed_count
       FROM action_items
       WHERE organizer_id = $1 ${userClause}`,
      params
    );

    const row = result.rows[0];
    res.json({
      total_open: parseInt(row.total_open, 10),
      p1_count: parseInt(row.p1_count, 10),
      p2_count: parseInt(row.p2_count, 10),
      p3_count: parseInt(row.p3_count, 10),
      p4_count: parseInt(row.p4_count, 10),
      snoozed_count: parseInt(row.snoozed_count, 10),
    });
  } catch (err) {
    console.error('[Actions] GET /summary error:', err.message);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/actions/:id — update status
// ---------------------------------------------------------------------------
router.patch('/:id', authRequired, async (req, res) => {
  try {
    const { organizer_id, user_id } = req.auth;
    const { id } = req.params;
    const { status, snoozed_until, resolution_note } = req.body;

    const validStatuses = ['open', 'in_progress', 'done', 'dismissed', 'snoozed'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
    }

    if (status === 'snoozed' && !snoozed_until) {
      return res.status(400).json({ error: 'snoozed_until is required when status is snoozed' });
    }

    const sets = ['status = $3'];
    const params = [organizer_id, id, status];
    let paramIdx = 4;

    if (status === 'snoozed') {
      sets.push(`snoozed_until = $${paramIdx}`);
      params.push(snoozed_until);
      paramIdx++;
    } else {
      sets.push('snoozed_until = NULL');
    }

    if (status === 'done' || status === 'dismissed') {
      sets.push(`resolved_at = NOW()`);
      sets.push(`resolved_by = $${paramIdx}`);
      params.push(user_id);
      paramIdx++;

      if (resolution_note) {
        sets.push(`resolution_note = $${paramIdx}`);
        params.push(resolution_note);
        paramIdx++;
      }
    }

    const result = await db.query(
      `UPDATE action_items SET ${sets.join(', ')}
       WHERE organizer_id = $1 AND id = $2
       RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Action item not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Actions] PATCH /:id error:', err.message);
    res.status(500).json({ error: 'Failed to update action item' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/actions — create manual_flag action item
// ---------------------------------------------------------------------------
router.post('/', authRequired, async (req, res) => {
  try {
    const { organizer_id, user_id } = req.auth;
    const { person_id, campaign_id, trigger_detail } = req.body;

    if (!person_id) {
      return res.status(400).json({ error: 'person_id is required' });
    }

    // Verify person belongs to this organizer
    const personRes = await db.query(
      `SELECT id FROM persons WHERE id = $1 AND organizer_id = $2`,
      [person_id, organizer_id]
    );
    if (personRes.rows.length === 0) {
      return res.status(404).json({ error: 'Person not found' });
    }

    const engagementScore = await computeEngagementScore(person_id, organizer_id);

    await upsertActionItem({
      organizerId: organizer_id,
      assignedTo: user_id,
      personId: person_id,
      campaignId: campaign_id || null,
      triggerReason: 'manual_flag',
      triggerDetail: trigger_detail || 'Manually flagged for follow-up',
      priority: 4,
      priorityLabel: 'P4',
      lastActivityAt: new Date().toISOString(),
      engagementScore,
    });

    res.status(201).json({ success: true });
  } catch (err) {
    console.error('[Actions] POST / error:', err.message);
    res.status(500).json({ error: 'Failed to create action item' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/actions/history — resolved items
// ---------------------------------------------------------------------------
router.get('/history', authRequired, async (req, res) => {
  try {
    const { organizer_id, user_id, role } = req.auth;
    const { limit: rawLimit, offset: rawOffset } = req.query;
    const params = [organizer_id];
    let paramIdx = 2;

    const histScope = getHierarchicalScope(req, 'ai.assigned_to', paramIdx);
    const userClause = histScope.sql;
    params.push(...histScope.params);
    paramIdx = histScope.nextIndex;

    const limit = Math.min(parseInt(rawLimit, 10) || 50, 200);
    const offset = parseInt(rawOffset, 10) || 0;

    const result = await db.query(
      `SELECT ai.*,
              p.email AS person_email,
              p.first_name AS person_first_name,
              p.last_name AS person_last_name,
              COALESCE(ru.first_name || ' ' || ru.last_name, ru.email) AS resolved_by_name
       FROM action_items ai
       LEFT JOIN persons p ON p.id = ai.person_id
       LEFT JOIN users ru ON ru.id = ai.resolved_by
       WHERE ai.organizer_id = $1
         ${userClause}
         AND ai.status IN ('done', 'dismissed')
       ORDER BY ai.resolved_at DESC NULLS LAST
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    res.json({ items: result.rows, count: result.rows.length });
  } catch (err) {
    console.error('[Actions] GET /history error:', err.message);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

module.exports = router;
