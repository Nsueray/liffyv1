/**
 * User Management — owner/admin only endpoints for managing team members.
 *
 * Mounted at /api/users in server.js.
 *
 * Routes:
 *   GET    /api/users                     list users in the organizer
 *   POST   /api/users                     create a new user
 *   PATCH  /api/users/:id                 update a user (role, name, limit, is_active)
 *   POST   /api/users/:id/reset-password  set a new password for a user
 *   GET    /api/users/:id/stats           per-user activity stats
 *
 * All endpoints require authenticated owner or admin in the same organizer.
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { isPrivileged, getUserContext } = require('../middleware/userScope');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_REGEX.test(v);

const VALID_ROLES = ['owner', 'admin', 'manager', 'sales_rep'];

// -----------------------------------------------------------------------------
// Guard: only owner/admin can use these endpoints
// -----------------------------------------------------------------------------
function requirePrivileged(req, res, next) {
  if (!isPrivileged(req)) {
    return res.status(403).json({ error: 'Only owner or admin can manage users' });
  }
  next();
}

// -----------------------------------------------------------------------------
// GET /api/users — list users in the current organizer
// -----------------------------------------------------------------------------
router.get('/', authRequired, requirePrivileged, async (req, res) => {
  try {
    const { organizerId } = getUserContext(req);
    const r = await db.query(
      `SELECT id, email, role, is_active, first_name, last_name,
              daily_email_limit, reports_to, manager_id, created_at
         FROM users
        WHERE organizer_id = $1
        ORDER BY
          CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END,
          created_at ASC`,
      [organizerId]
    );
    res.json({ users: r.rows });
  } catch (err) {
    console.error('GET /api/users error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// POST /api/users — create a new user in the current organizer
// body: { email, password, role, first_name?, last_name?, daily_email_limit? }
// -----------------------------------------------------------------------------
router.post('/', authRequired, requirePrivileged, async (req, res) => {
  try {
    const { organizerId, role: actorRole } = getUserContext(req);
    const {
      email,
      password,
      role,
      first_name,
      last_name,
      daily_email_limit,
      reports_to,
      manager_id,
    } = req.body || {};

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!role || !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }
    // Only owner can create another owner
    if (role === 'owner' && actorRole !== 'owner') {
      return res.status(403).json({ error: 'Only owner can create another owner' });
    }

    // Check duplicate email (global unique constraint)
    const dupRes = await db.query(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [email]
    );
    if (dupRes.rows.length > 0) {
      return res.status(409).json({ error: 'Email already in use' });
    }

    const hash = await bcrypt.hash(password, 10);
    const limit = Number.isFinite(+daily_email_limit) && +daily_email_limit >= 0
      ? parseInt(daily_email_limit, 10)
      : 500;

    const reportsToVal = (reports_to && isUuid(reports_to)) ? reports_to
                       : (manager_id && isUuid(manager_id)) ? manager_id
                       : null;
    const insertRes = await db.query(
      `INSERT INTO users
         (organizer_id, email, password_hash, role, first_name, last_name, daily_email_limit, reports_to, manager_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       RETURNING id, email, role, is_active, first_name, last_name, daily_email_limit, reports_to, manager_id, created_at`,
      [
        organizerId,
        email.trim().toLowerCase(),
        hash,
        role,
        first_name || null,
        last_name || null,
        limit,
        reportsToVal,
      ]
    );

    res.status(201).json({ user: insertRes.rows[0] });
  } catch (err) {
    console.error('POST /api/users error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// PATCH /api/users/:id — update role / name / daily limit / is_active
// -----------------------------------------------------------------------------
router.patch('/:id', authRequired, requirePrivileged, async (req, res) => {
  try {
    const { id } = req.params;
    const { organizerId, userId: actorId, role: actorRole } = getUserContext(req);

    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid user id' });

    // Load target user in the same organizer
    const tgtRes = await db.query(
      `SELECT id, role FROM users WHERE id = $1 AND organizer_id = $2 LIMIT 1`,
      [id, organizerId]
    );
    if (tgtRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const target = tgtRes.rows[0];

    // Prevent non-owners from touching owner accounts
    if (target.role === 'owner' && actorRole !== 'owner') {
      return res.status(403).json({ error: 'Only owner can modify an owner account' });
    }
    // Prevent an owner from demoting themselves if they are the last owner
    if (target.id === actorId && target.role === 'owner' && req.body && req.body.role && req.body.role !== 'owner') {
      const ownerCountRes = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM users WHERE organizer_id = $1 AND role = 'owner' AND is_active = true`,
        [organizerId]
      );
      if ((ownerCountRes.rows[0].cnt || 0) <= 1) {
        return res.status(400).json({ error: 'Cannot demote the last owner' });
      }
    }

    const allowed = ['role', 'first_name', 'last_name', 'daily_email_limit', 'is_active', 'reports_to', 'manager_id'];
    const sets = [];
    const vals = [];
    let idx = 1;

    for (const k of allowed) {
      if (req.body && k in req.body) {
        let v = req.body[k];
        if (k === 'role') {
          if (!VALID_ROLES.includes(v)) {
            return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
          }
          if (v === 'owner' && actorRole !== 'owner') {
            return res.status(403).json({ error: 'Only owner can assign owner role' });
          }
        }
        if (k === 'daily_email_limit') {
          const n = parseInt(v, 10);
          if (!Number.isFinite(n) || n < 0) {
            return res.status(400).json({ error: 'daily_email_limit must be a non-negative integer' });
          }
          v = n;
        }
        if (k === 'is_active') v = !!v;
        if (k === 'manager_id' || k === 'reports_to') {
          v = (v && isUuid(v)) ? v : null; // null clears the manager/reports_to
        }
        sets.push(`${k} = $${idx++}`);
        vals.push(v);
      }
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    vals.push(id, organizerId);
    const q = `UPDATE users SET ${sets.join(', ')}
                WHERE id = $${idx++} AND organizer_id = $${idx}
            RETURNING id, email, role, is_active, first_name, last_name, daily_email_limit, reports_to, manager_id, created_at`;
    const r = await db.query(q, vals);

    res.json({ user: r.rows[0] });
  } catch (err) {
    console.error('PATCH /api/users/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// POST /api/users/:id/reset-password — set a new password
// body: { password }
// -----------------------------------------------------------------------------
router.post('/:id/reset-password', authRequired, requirePrivileged, async (req, res) => {
  try {
    const { id } = req.params;
    const { organizerId, role: actorRole } = getUserContext(req);
    const { password } = req.body || {};

    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid user id' });
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const tgtRes = await db.query(
      `SELECT id, role FROM users WHERE id = $1 AND organizer_id = $2 LIMIT 1`,
      [id, organizerId]
    );
    if (tgtRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (tgtRes.rows[0].role === 'owner' && actorRole !== 'owner') {
      return res.status(403).json({ error: 'Only owner can reset an owner password' });
    }

    const hash = await bcrypt.hash(password, 10);
    await db.query(
      `UPDATE users SET password_hash = $1 WHERE id = $2 AND organizer_id = $3`,
      [hash, id, organizerId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/users/:id/reset-password error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// GET /api/users/:id/stats — activity snapshot for a single user
// -----------------------------------------------------------------------------
router.get('/:id/stats', authRequired, requirePrivileged, async (req, res) => {
  try {
    const { id } = req.params;
    const { organizerId } = getUserContext(req);

    if (!isUuid(id)) return res.status(400).json({ error: 'Invalid user id' });

    const tgtRes = await db.query(
      `SELECT id, email, role, daily_email_limit FROM users
        WHERE id = $1 AND organizer_id = $2 LIMIT 1`,
      [id, organizerId]
    );
    if (tgtRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = tgtRes.rows[0];

    const [campaignsRes, miningRes, sentTodayRes, tasksRes] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'sending')::int AS sending,
                COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
           FROM campaigns
          WHERE organizer_id = $1 AND created_by_user_id = $2`,
        [organizerId, id]
      ),
      db.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
                COUNT(*) FILTER (WHERE status = 'running')::int AS running
           FROM mining_jobs
          WHERE organizer_id = $1 AND created_by_user_id = $2`,
        [organizerId, id]
      ),
      db.query(
        `SELECT COUNT(*)::int AS sent_today
           FROM campaign_events ce
           JOIN campaigns c ON c.id = ce.campaign_id
          WHERE ce.organizer_id = $1
            AND c.created_by_user_id = $2
            AND ce.event_type = 'sent'
            AND ce.occurred_at >= CURRENT_DATE`,
        [organizerId, id]
      ),
      db.query(
        `SELECT
            COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE status = 'pending' AND due_date < CURRENT_DATE)::int AS overdue,
            COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
           FROM contact_tasks
          WHERE organizer_id = $1 AND assigned_to = $2`,
        [organizerId, id]
      ),
    ]);

    const sentToday = sentTodayRes.rows[0].sent_today || 0;
    const dailyLimit = parseInt(user.daily_email_limit, 10) || 0;

    res.json({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        daily_email_limit: dailyLimit,
      },
      email_usage: {
        sent_today: sentToday,
        daily_limit: dailyLimit,
        remaining: Math.max(0, dailyLimit - sentToday),
      },
      campaigns: campaignsRes.rows[0],
      mining_jobs: miningRes.rows[0],
      tasks: tasksRes.rows[0],
    });
  } catch (err) {
    console.error('GET /api/users/:id/stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
