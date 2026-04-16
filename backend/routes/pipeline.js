/**
 * Sales Pipeline — stages + per-person stage management
 *
 * All endpoints:
 *   - Auth: JWT via authRequired (req.auth.organizer_id, req.auth.user_id)
 *   - Multi-tenant: every query filters by organizer_id
 *
 * Routes are mounted under /api/pipeline in server.js, EXCEPT the
 * PATCH /api/persons/:id/stage endpoint which lives here for cohesion
 * and is mounted at root by server.js (see comment in server.js).
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { isPrivileged, getUserContext, canAccessRow } = require('../middleware/userScope');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_REGEX.test(v);

// -----------------------------------------------------------------------------
// Helper: stage ownership
// -----------------------------------------------------------------------------
async function getStage(stageId, organizerId) {
  if (!isUuid(stageId)) return null;
  const r = await db.query(
    `SELECT * FROM pipeline_stages WHERE id = $1 AND organizer_id = $2 LIMIT 1`,
    [stageId, organizerId]
  );
  return r.rows[0] || null;
}

// =============================================================================
// STAGES
// =============================================================================

// GET /api/pipeline/stages — list organizer's stages
router.get('/api/pipeline/stages', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const r = await db.query(
      `SELECT id, name, sort_order, color, is_won, is_lost, created_at
         FROM pipeline_stages
        WHERE organizer_id = $1
        ORDER BY sort_order ASC, created_at ASC`,
      [organizerId]
    );
    res.json({ stages: r.rows });
  } catch (err) {
    console.error('GET stages error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pipeline/stages — create stage (owner/admin only)
router.post('/api/pipeline/stages', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const role = req.auth.role;
    if (role !== 'owner' && role !== 'admin') {
      return res.status(403).json({ error: 'Only owner or admin can create stages' });
    }

    const { name, sort_order, color, is_won, is_lost } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    // If no sort_order supplied, append at end
    let order = parseInt(sort_order, 10);
    if (Number.isNaN(order)) {
      const maxRes = await db.query(
        `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order
           FROM pipeline_stages WHERE organizer_id = $1`,
        [organizerId]
      );
      order = maxRes.rows[0].next_order;
    }

    const r = await db.query(
      `INSERT INTO pipeline_stages
         (organizer_id, name, sort_order, color, is_won, is_lost)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        organizerId,
        name.trim(),
        order,
        color || '#6B7280',
        !!is_won,
        !!is_lost,
      ]
    );
    res.status(201).json({ stage: r.rows[0] });
  } catch (err) {
    console.error('POST stages error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/pipeline/stages/:id — update stage
router.patch('/api/pipeline/stages/:id', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const role = req.auth.role;
    const { id } = req.params;

    if (role !== 'owner' && role !== 'admin') {
      return res.status(403).json({ error: 'Only owner or admin can update stages' });
    }
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid stage id' });

    const allowed = ['name', 'color', 'sort_order', 'is_won', 'is_lost'];
    const sets = [];
    const vals = [];
    let idx = 1;
    for (const k of allowed) {
      if (req.body && k in req.body) {
        sets.push(`${k} = $${idx++}`);
        vals.push(req.body[k]);
      }
    }
    if (sets.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    vals.push(id, organizerId);
    const q = `UPDATE pipeline_stages
                  SET ${sets.join(', ')}
                WHERE id = $${idx++} AND organizer_id = $${idx}
            RETURNING *`;
    const r = await db.query(q, vals);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Stage not found' });

    res.json({ stage: r.rows[0] });
  } catch (err) {
    console.error('PATCH stages error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/pipeline/stages/:id — delete stage
// Thanks to ON DELETE SET NULL on persons.pipeline_stage_id, assigned
// persons will automatically have their pipeline_stage_id cleared.
router.delete('/api/pipeline/stages/:id', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const role = req.auth.role;
    const { id } = req.params;

    if (role !== 'owner' && role !== 'admin') {
      return res.status(403).json({ error: 'Only owner or admin can delete stages' });
    }
    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid stage id' });

    const r = await db.query(
      `DELETE FROM pipeline_stages
        WHERE id = $1 AND organizer_id = $2
        RETURNING id`,
      [id, organizerId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Stage not found' });

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE stages error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// BOARD — stages with people
// =============================================================================

// GET /api/pipeline/board?limit=50
// Returns every stage with up to `limit` people per stage.
// Each person includes: id, email, first_name, last_name, company (latest
// affiliation), pipeline_entered_at, last_activity { type, occurred_at }.
router.get('/api/pipeline/board', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));

    const stagesRes = await db.query(
      `SELECT id, name, sort_order, color, is_won, is_lost
         FROM pipeline_stages
        WHERE organizer_id = $1
        ORDER BY sort_order ASC, created_at ASC`,
      [organizerId]
    );
    const stages = stagesRes.rows;

    if (stages.length === 0) {
      return res.json({ stages: [], total_people: 0 });
    }

    // Single query: for each stage, return up to `limit` most-recently-entered persons,
    // with their most recent affiliation (LATERAL) and latest activity (LATERAL).
    const q = `
      WITH ranked AS (
        SELECT
          p.id,
          p.email,
          p.first_name,
          p.last_name,
          p.pipeline_stage_id,
          p.pipeline_entered_at,
          ROW_NUMBER() OVER (
            PARTITION BY p.pipeline_stage_id
            ORDER BY p.pipeline_entered_at DESC NULLS LAST, p.created_at DESC
          ) AS rn,
          COUNT(*) OVER (PARTITION BY p.pipeline_stage_id) AS stage_count
        FROM persons p
        WHERE p.organizer_id = $1
          AND p.pipeline_stage_id IS NOT NULL
      )
      SELECT
        r.id,
        r.email,
        r.first_name,
        r.last_name,
        r.pipeline_stage_id,
        r.pipeline_entered_at,
        r.stage_count,
        aff.company_name,
        aff.position,
        act.activity_type AS last_activity_type,
        act.occurred_at   AS last_activity_at
      FROM ranked r
      LEFT JOIN LATERAL (
        SELECT company_name, position
          FROM affiliations a
         WHERE a.person_id = r.id AND a.organizer_id = $1
         ORDER BY a.created_at DESC
         LIMIT 1
      ) aff ON TRUE
      LEFT JOIN LATERAL (
        SELECT activity_type, occurred_at
          FROM contact_activities ca
         WHERE ca.person_id = r.id AND ca.organizer_id = $1
         ORDER BY ca.occurred_at DESC
         LIMIT 1
      ) act ON TRUE
      WHERE r.rn <= $2
      ORDER BY r.pipeline_stage_id, r.pipeline_entered_at DESC NULLS LAST
    `;
    const peopleRes = await db.query(q, [organizerId, limit]);

    // Also get exact count per stage (for when stage has > limit)
    // stage_count is already included in the window, but if a stage has 0 people
    // it won't appear in peopleRes at all, so we'll populate from stages and patch counts.
    const countsByStage = new Map();
    for (const row of peopleRes.rows) {
      countsByStage.set(row.pipeline_stage_id, parseInt(row.stage_count, 10));
    }

    // Group people by stage
    const peopleByStage = new Map();
    for (const row of peopleRes.rows) {
      if (!peopleByStage.has(row.pipeline_stage_id)) {
        peopleByStage.set(row.pipeline_stage_id, []);
      }
      peopleByStage.get(row.pipeline_stage_id).push({
        id: row.id,
        email: row.email,
        first_name: row.first_name,
        last_name: row.last_name,
        company_name: row.company_name,
        position: row.position,
        pipeline_entered_at: row.pipeline_entered_at,
        last_activity_type: row.last_activity_type,
        last_activity_at: row.last_activity_at,
      });
    }

    let total = 0;
    const result = stages.map((s) => {
      const count = countsByStage.get(s.id) || 0;
      total += count;
      return {
        id: s.id,
        name: s.name,
        sort_order: s.sort_order,
        color: s.color,
        is_won: s.is_won,
        is_lost: s.is_lost,
        count,
        people: peopleByStage.get(s.id) || [],
      };
    });

    res.json({ stages: result, total_people: total });
  } catch (err) {
    console.error('GET board error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// PERSON STAGE ASSIGNMENT
// =============================================================================
// PATCH /api/persons/:id/stage  body: { stage_id }
// NOTE: this is a /api/persons path, so in server.js we mount this router at
// root level (no /api/pipeline prefix) BEFORE the /api/persons router.
//
// Ownership:
//   - If the person has no pipeline_assigned_user_id, the first user to
//     change the stage becomes the assignee.
//   - After that, only owner/admin or the assigned user may change the stage.
router.patch('/api/persons/:id/stage', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const userId = req.auth.user_id;
    const { id } = req.params;
    const { stage_id } = req.body || {};

    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid person id' });
    // stage_id may be null (to un-assign), otherwise must be a uuid owned by org
    if (stage_id !== null && stage_id !== undefined && !isUuid(stage_id)) {
      return res.status(400).json({ error: 'Invalid stage_id' });
    }

    // Load current person (for from_stage + ownership check)
    const personRes = await db.query(
      `SELECT id, pipeline_stage_id, pipeline_assigned_user_id FROM persons
        WHERE id = $1 AND organizer_id = $2 LIMIT 1`,
      [id, organizerId]
    );
    if (personRes.rows.length === 0) {
      return res.status(404).json({ error: 'Person not found' });
    }
    const fromStageId = personRes.rows[0].pipeline_stage_id;
    const currentAssignee = personRes.rows[0].pipeline_assigned_user_id;

    // Ownership enforcement for non-privileged users (managers can access team's)
    if (currentAssignee && !canAccessRow(req, currentAssignee)) {
      return res.status(403).json({ error: 'This contact is assigned to another user' });
    }

    let toStage = null;
    if (stage_id) {
      toStage = await getStage(stage_id, organizerId);
      if (!toStage) return res.status(404).json({ error: 'Stage not found' });
    }

    // Auto-assign: on first stage change, current user becomes the assignee.
    // Owner/admin leaves an existing assignee untouched; only fills NULLs.
    const nextAssignee = currentAssignee || userId;

    // Update person
    const updRes = await db.query(
      `UPDATE persons
          SET pipeline_stage_id = $1,
              pipeline_entered_at = CASE WHEN $1 IS NULL THEN NULL ELSE NOW() END,
              pipeline_assigned_user_id = CASE WHEN $1 IS NULL THEN NULL ELSE $4 END
        WHERE id = $2 AND organizer_id = $3
        RETURNING id, pipeline_stage_id, pipeline_entered_at, pipeline_assigned_user_id`,
      [stage_id || null, id, organizerId, nextAssignee]
    );

    // Resolve from_stage name for activity meta (best-effort)
    let fromStageName = null;
    if (fromStageId) {
      const fr = await db.query(
        `SELECT name FROM pipeline_stages WHERE id = $1 AND organizer_id = $2 LIMIT 1`,
        [fromStageId, organizerId]
      );
      fromStageName = fr.rows[0] ? fr.rows[0].name : null;
    }

    // Write status_change activity (best-effort)
    try {
      await db.query(
        `INSERT INTO contact_activities
           (organizer_id, person_id, user_id, activity_type, description, meta)
         VALUES ($1, $2, $3, 'status_change', $4, $5)`,
        [
          organizerId,
          id,
          userId,
          toStage ? `Moved to ${toStage.name}` : 'Removed from pipeline',
          JSON.stringify({
            from_stage: fromStageName,
            to_stage: toStage ? toStage.name : null,
            from_stage_id: fromStageId,
            to_stage_id: toStage ? toStage.id : null,
          }),
        ]
      );
    } catch (actErr) {
      console.warn('[pipeline] contact_activities insert failed:', actErr.message);
    }

    res.json({ person: updRes.rows[0] });
  } catch (err) {
    console.error('PATCH stage error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
