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
 *   req.auth = { user_id, organizer_id, role, email }
 *   req.user = same reference (alias for new-style code)
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'liffy_secret_key_change_me';

function authRequired(req, res, next) {
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

    req.auth = {
      user_id: payload.user_id,
      organizer_id: payload.organizer_id,
      role: payload.role,
      email: payload.email || null,
    };
    // Alias: new code can use req.user with .id instead of .user_id
    req.user = {
      id: payload.user_id,
      user_id: payload.user_id,
      organizer_id: payload.organizer_id,
      role: payload.role,
      email: payload.email || null,
    };

    next();
  } catch (err) {
    console.error('[auth] Invalid token:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { authRequired, JWT_SECRET };
