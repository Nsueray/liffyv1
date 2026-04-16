/**
 * Centralized JWT auth middleware.
 *
 * Mirrors the existing `authRequired` pattern that is duplicated across
 * backend/routes/*.js. Use this for NEW routes. Existing routes keep their
 * local copies to avoid a risky mass refactor.
 *
 * Usage:
 *   const { authRequired } = require('../middleware/auth');
 *   router.get('/api/foo', authRequired, (req, res) => { ... });
 *
 * Sets:
 *   req.auth = { user_id, organizer_id, role, email, team_ids }
 *   req.user = same reference (alias for new-style code)
 *
 * For managers: team_ids is populated with direct-report user IDs (one DB query).
 * For owner/admin/user: team_ids is [].
 */

const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'liffy_secret_key_change_me';

async function authRequired(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing Authorization header' });
    }

    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) {
      return res.status(401).json({ error: 'Invalid token format' });
    }

    const payload = jwt.verify(token, JWT_SECRET);

    // Load team_ids for managers (direct reports)
    let teamIds = [];
    if (payload.role === 'manager') {
      try {
        const teamRes = await db.query(
          `SELECT id FROM users WHERE manager_id = $1 AND organizer_id = $2`,
          [payload.user_id, payload.organizer_id]
        );
        teamIds = teamRes.rows.map(r => r.id);
      } catch (err) {
        // If manager_id column doesn't exist yet (migration not applied), skip
        console.warn('[auth] team_ids query failed (migration pending?):', err.message);
      }
    }

    req.auth = {
      user_id: payload.user_id,
      organizer_id: payload.organizer_id,
      role: payload.role,
      email: payload.email || null,
      team_ids: teamIds,
    };
    // Alias: new code can use req.user with .id instead of .user_id
    req.user = {
      id: payload.user_id,
      user_id: payload.user_id,
      organizer_id: payload.organizer_id,
      role: payload.role,
      email: payload.email || null,
      team_ids: teamIds,
    };

    next();
  } catch (err) {
    console.error('[auth] Invalid token:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { authRequired, JWT_SECRET };
