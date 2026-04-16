/**
 * Contact CRM — notes, activities, tasks
 *
 * All endpoints:
 *  - Auth: JWT via authRequired (req.auth.organizer_id, req.auth.user_id)
 *  - Multi-tenant: every query filters by organizer_id
 *  - Person ownership is verified by a single JOIN against persons.organizer_id
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { isPrivileged, isManager, userScopeFilter, getUserContext, canAccessRow } = require('../middleware/userScope');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_REGEX.test(v);

// -----------------------------------------------------------------------------
// Helper: verify person belongs to organizer
// -----------------------------------------------------------------------------
async function assertPersonOwnership(personId, organizerId) {
  if (!isUuid(personId)) return false;
  const r = await db.query(
    `SELECT id FROM persons WHERE id = $1 AND organizer_id = $2 LIMIT 1`,
    [personId, organizerId]
  );
  return r.rows.length > 0;
}

// -----------------------------------------------------------------------------
// Helper: best-effort activity write (exported for other modules via recordActivity)
// -----------------------------------------------------------------------------
async function writeActivity({ organizerId, personId, userId, activityType, description, meta, occurredAt }) {
  try {
    await db.query(
      `INSERT INTO contact_activities
         (organizer_id, person_id, user_id, activity_type, description, meta, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()))`,
      [
        organizerId,
        personId,
        userId || null,
        activityType,
        description || null,
        meta ? JSON.stringify(meta) : null,
        occurredAt || null,
      ]
    );
  } catch (err) {
    console.error('[contactCrm] writeActivity failed:', err.message);
  }
}

// =============================================================================
// NOTES
// =============================================================================

// GET /api/persons/:personId/notes — list notes (newest first)
// Non-privileged users see only their own notes.
router.get('/api/persons/:personId/notes', authRequired, async (req, res) => {
  try {
    const { personId } = req.params;
    const organizerId = req.auth.organizer_id;

    if (!(await assertPersonOwnership(personId, organizerId))) {
      return res.status(404).json({ error: 'Person not found' });
    }

    const scope = userScopeFilter(req, 3, 'n.user_id');

    const r = await db.query(
      `SELECT n.id, n.content, n.created_at,
              n.user_id, u.email AS user_email
         FROM contact_notes n
         LEFT JOIN users u ON n.user_id = u.id
        WHERE n.person_id = $1 AND n.organizer_id = $2${scope.clause}
        ORDER BY n.created_at DESC`,
      [personId, organizerId, ...scope.params]
    );

    res.json({ notes: r.rows });
  } catch (err) {
    console.error('GET notes error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/persons/:personId/notes — add note + auto-activity
router.post('/api/persons/:personId/notes', authRequired, async (req, res) => {
  try {
    const { personId } = req.params;
    const organizerId = req.auth.organizer_id;
    const userId = req.auth.user_id;
    const { content } = req.body || {};

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'content is required' });
    }
    if (!(await assertPersonOwnership(personId, organizerId))) {
      return res.status(404).json({ error: 'Person not found' });
    }

    const r = await db.query(
      `INSERT INTO contact_notes (organizer_id, person_id, user_id, content)
       VALUES ($1, $2, $3, $4)
       RETURNING id, content, created_at, user_id`,
      [organizerId, personId, userId, content.trim()]
    );

    const note = r.rows[0];

    // Auto-activity: note_added
    await writeActivity({
      organizerId,
      personId,
      userId,
      activityType: 'note_added',
      description: content.trim().substring(0, 200),
    });

    res.status(201).json({ note });
  } catch (err) {
    console.error('POST notes error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/persons/:personId/notes/:noteId
// Non-privileged users can only delete their own notes.
router.delete('/api/persons/:personId/notes/:noteId', authRequired, async (req, res) => {
  try {
    const { personId, noteId } = req.params;
    const organizerId = req.auth.organizer_id;

    if (!isUuid(noteId)) return res.status(400).json({ error: 'Invalid noteId' });
    if (!(await assertPersonOwnership(personId, organizerId))) {
      return res.status(404).json({ error: 'Person not found' });
    }

    const params = [noteId, personId, organizerId];
    let userFilter = '';
    if (!isPrivileged(req)) {
      const { userId, teamIds } = getUserContext(req);
      const allIds = [userId, ...teamIds];
      const ph = allIds.map((_, i) => `$${params.length + 1 + i}`).join(', ');
      userFilter = ` AND user_id IN (${ph})`;
      params.push(...allIds);
    }

    const r = await db.query(
      `DELETE FROM contact_notes
        WHERE id = $1 AND person_id = $2 AND organizer_id = $3${userFilter}
        RETURNING id`,
      params
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Note not found' });

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE notes error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// ACTIVITIES (read-only timeline)
// =============================================================================

router.get('/api/persons/:personId/activities', authRequired, async (req, res) => {
  try {
    const { personId } = req.params;
    const organizerId = req.auth.organizer_id;

    if (!(await assertPersonOwnership(personId, organizerId))) {
      return res.status(404).json({ error: 'Person not found' });
    }

    // Non-privileged users only see activities they recorded. System-generated
    // activities (user_id IS NULL) stay visible to everyone.
    const filterParams = [personId, organizerId];
    let userFilter = '';
    if (!isPrivileged(req)) {
      const { userId, teamIds } = getUserContext(req);
      const allIds = [userId, ...teamIds];
      const ph = allIds.map((_, i) => `$${filterParams.length + 1 + i}`).join(', ');
      userFilter = ` AND (a.user_id IN (${ph}) OR a.user_id IS NULL)`;
      filterParams.push(...allIds);
    }

    const r = await db.query(
      `SELECT a.id, a.activity_type, a.description, a.meta,
              a.occurred_at, a.created_at,
              a.user_id, u.email AS user_email
         FROM contact_activities a
         LEFT JOIN users u ON a.user_id = u.id
        WHERE a.person_id = $1 AND a.organizer_id = $2${userFilter}
        ORDER BY a.occurred_at DESC
        LIMIT 200`,
      filterParams
    );

    res.json({ activities: r.rows });
  } catch (err) {
    console.error('GET activities error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// TASKS — per-person
// =============================================================================

// GET /api/persons/:personId/tasks
// Non-privileged users only see tasks assigned to them or created by them.
router.get('/api/persons/:personId/tasks', authRequired, async (req, res) => {
  try {
    const { personId } = req.params;
    const organizerId = req.auth.organizer_id;

    if (!(await assertPersonOwnership(personId, organizerId))) {
      return res.status(404).json({ error: 'Person not found' });
    }

    const params = [personId, organizerId];
    let userFilter = '';
    if (!isPrivileged(req)) {
      const { userId, teamIds } = getUserContext(req);
      const allIds = [userId, ...teamIds];
      const ph = allIds.map((_, i) => `$${params.length + 1 + i}`).join(', ');
      userFilter = ` AND (t.assigned_to IN (${ph}) OR t.created_by IN (${ph}))`;
      params.push(...allIds);
    }

    const r = await db.query(
      `SELECT t.*,
              ua.email AS assigned_to_email,
              uc.email AS created_by_email
         FROM contact_tasks t
         LEFT JOIN users ua ON t.assigned_to = ua.id
         LEFT JOIN users uc ON t.created_by = uc.id
        WHERE t.person_id = $1 AND t.organizer_id = $2${userFilter}
        ORDER BY
          CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END,
          t.due_date NULLS LAST,
          t.created_at DESC`,
      params
    );

    res.json({ tasks: r.rows });
  } catch (err) {
    console.error('GET tasks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/persons/:personId/tasks — create task + auto-activity
router.post('/api/persons/:personId/tasks', authRequired, async (req, res) => {
  try {
    const { personId } = req.params;
    const organizerId = req.auth.organizer_id;
    const userId = req.auth.user_id;
    const { title, description, due_date, priority, assigned_to } = req.body || {};

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'title is required' });
    }
    if (!(await assertPersonOwnership(personId, organizerId))) {
      return res.status(404).json({ error: 'Person not found' });
    }

    const prio = ['low', 'normal', 'high'].includes(priority) ? priority : 'normal';

    // assigned_to defaults to current user; only accept if UUID
    const assignee = isUuid(assigned_to) ? assigned_to : userId;

    const r = await db.query(
      `INSERT INTO contact_tasks
         (organizer_id, person_id, assigned_to, created_by, title, description, due_date, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        organizerId,
        personId,
        assignee,
        userId,
        title.trim(),
        description || null,
        due_date || null,
        prio,
      ]
    );
    const task = r.rows[0];

    await writeActivity({
      organizerId,
      personId,
      userId,
      activityType: 'task_created',
      description: `Task: ${task.title}`,
      meta: { task_id: task.id, due_date: task.due_date, priority: task.priority },
    });

    res.status(201).json({ task });
  } catch (err) {
    console.error('POST tasks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// TASKS — standalone (not tied to a person path)
// =============================================================================

// PATCH /api/tasks/:taskId
router.patch('/api/tasks/:taskId', authRequired, async (req, res) => {
  try {
    const { taskId } = req.params;
    const organizerId = req.auth.organizer_id;
    const userId = req.auth.user_id;

    if (!isUuid(taskId)) return res.status(400).json({ error: 'Invalid taskId' });

    // Ownership check — non-privileged users can only patch tasks
    // assigned to them or created by them (managers include team).
    if (!isPrivileged(req)) {
      const { teamIds } = getUserContext(req);
      const allIds = [userId, ...teamIds];
      const ph = allIds.map((_, i) => `$${i + 3}`).join(', ');
      const ownRes = await db.query(
        `SELECT 1 FROM contact_tasks
          WHERE id = $1 AND organizer_id = $2
            AND (assigned_to IN (${ph}) OR created_by IN (${ph}))
          LIMIT 1`,
        [taskId, organizerId, ...allIds]
      );
      if (ownRes.rowCount === 0) {
        return res.status(404).json({ error: 'Task not found' });
      }
    }

    const allowed = ['title', 'description', 'due_date', 'status', 'priority', 'assigned_to'];
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

    // If status becomes 'completed', set completed_at
    if (req.body && req.body.status === 'completed') {
      sets.push(`completed_at = NOW()`);
    }
    // If status moves away from completed, clear completed_at
    if (req.body && req.body.status && req.body.status !== 'completed') {
      sets.push(`completed_at = NULL`);
    }

    vals.push(taskId, organizerId);
    const q = `UPDATE contact_tasks
                  SET ${sets.join(', ')}
                WHERE id = $${idx++} AND organizer_id = $${idx}
            RETURNING *`;

    const r = await db.query(q, vals);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Task not found' });

    const task = r.rows[0];

    if (req.body.status === 'completed') {
      await writeActivity({
        organizerId,
        personId: task.person_id,
        userId,
        activityType: 'task_completed',
        description: `Completed: ${task.title}`,
        meta: { task_id: task.id },
      });
    }

    res.json({ task });
  } catch (err) {
    console.error('PATCH tasks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/tasks/:taskId
// Non-privileged users can only delete tasks they created.
router.delete('/api/tasks/:taskId', authRequired, async (req, res) => {
  try {
    const { taskId } = req.params;
    const organizerId = req.auth.organizer_id;

    if (!isUuid(taskId)) return res.status(400).json({ error: 'Invalid taskId' });

    const params = [taskId, organizerId];
    let userFilter = '';
    if (!isPrivileged(req)) {
      const { userId, teamIds } = getUserContext(req);
      const allIds = [userId, ...teamIds];
      const ph = allIds.map((_, i) => `$${params.length + 1 + i}`).join(', ');
      userFilter = ` AND created_by IN (${ph})`;
      params.push(...allIds);
    }

    const r = await db.query(
      `DELETE FROM contact_tasks WHERE id = $1 AND organizer_id = $2${userFilter} RETURNING id`,
      params
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Task not found' });

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE tasks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tasks — list all tasks with filters
//   ?status=pending|completed|cancelled|all
//   ?assigned_to=<uuid>|me   (default: me)
//   ?due=overdue|today|upcoming|all   (default: all)
router.get('/api/tasks', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const userId = req.auth.user_id;

    const status = req.query.status || 'pending';
    let assignedTo = req.query.assigned_to || 'me';
    if (assignedTo === 'me') assignedTo = userId;
    const due = req.query.due || 'all';

    const where = [`t.organizer_id = $1`];
    const vals = [organizerId];
    let idx = 2;

    if (status !== 'all') {
      where.push(`t.status = $${idx++}`);
      vals.push(status);
    }
    if (assignedTo && assignedTo !== 'all' && isUuid(assignedTo)) {
      where.push(`t.assigned_to = $${idx++}`);
      vals.push(assignedTo);
    }
    if (due === 'overdue') {
      where.push(`t.due_date < CURRENT_DATE AND t.status = 'pending'`);
    } else if (due === 'today') {
      where.push(`t.due_date = CURRENT_DATE`);
    } else if (due === 'upcoming') {
      where.push(`t.due_date >= CURRENT_DATE`);
    }

    const q = `
      SELECT t.*,
             p.email AS person_email,
             p.first_name AS person_first_name,
             p.last_name AS person_last_name,
             ua.email AS assigned_to_email
        FROM contact_tasks t
        JOIN persons p ON t.person_id = p.id
        LEFT JOIN users ua ON t.assigned_to = ua.id
       WHERE ${where.join(' AND ')}
       ORDER BY
         CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END,
         t.due_date NULLS LAST,
         t.created_at DESC
       LIMIT 500
    `;
    const r = await db.query(q, vals);
    res.json({ tasks: r.rows });
  } catch (err) {
    console.error('GET /api/tasks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tasks/summary — counts for sidebar badge + dashboards
router.get('/api/tasks/summary', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const userId = req.auth.user_id;

    const r = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending' AND due_date < CURRENT_DATE) AS overdue_count,
         COUNT(*) FILTER (WHERE status = 'pending' AND due_date = CURRENT_DATE) AS today_count,
         COUNT(*) FILTER (WHERE status = 'pending' AND due_date > CURRENT_DATE) AS upcoming_count
         FROM contact_tasks
        WHERE organizer_id = $1 AND assigned_to = $2`,
      [organizerId, userId]
    );

    const row = r.rows[0] || {};
    res.json({
      overdue_count: parseInt(row.overdue_count || 0, 10),
      today_count: parseInt(row.today_count || 0, 10),
      upcoming_count: parseInt(row.upcoming_count || 0, 10),
    });
  } catch (err) {
    console.error('GET /api/tasks/summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Export the writeActivity helper so other modules (webhooks, zohoService)
// can record auto-activities without duplicating SQL.
module.exports = router;
module.exports.writeActivity = writeActivity;
