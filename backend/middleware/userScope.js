/**
 * User scoping helpers for multi-user data isolation.
 *
 * Policy:
 *   - role === 'owner' or 'admin'  → sees every row within their organizer
 *   - role === 'user' (or anything else) → only their own rows
 *
 * Existing route files use TWO different auth middleware shapes:
 *   - Legacy local middleware  → req.auth = { user_id, organizer_id, role }
 *   - Shared middleware/auth.js → req.user = { id, user_id, organizer_id, role }
 *
 * These helpers read from BOTH shapes so they work in every route without
 * forcing a mass refactor of the existing `authRequired` duplicates.
 */

/**
 * Extract normalized auth context from a request.
 * @param {import('express').Request} req
 * @returns {{ userId: string|null, organizerId: string|null, role: string|null }}
 */
function getUserContext(req) {
  const u = req.user || req.auth || {};
  return {
    userId: u.id || u.user_id || null,
    organizerId: u.organizer_id || null,
    role: u.role || null,
  };
}

/**
 * True if the current user is owner or admin (sees everything in the org).
 */
function isPrivileged(req) {
  const { role } = getUserContext(req);
  return role === 'owner' || role === 'admin';
}

/**
 * Build an AND-clause fragment + params for filtering by a user-scoped column.
 *
 * Example:
 *   const scope = userScopeFilter(req, 3, 'created_by_user_id');
 *   const sql = `SELECT * FROM campaigns WHERE organizer_id = $1 ${scope.clause}`;
 *   const params = [orgId, ...scope.params];
 *
 * For privileged users the clause is empty and no params are added.
 *
 * @param {import('express').Request} req
 * @param {number} paramStartIdx — the next $N placeholder to use
 * @param {string} columnName — fully qualified column name, e.g. "c.created_by_user_id"
 * @returns {{ clause: string, params: any[], nextIdx: number }}
 */
function userScopeFilter(req, paramStartIdx, columnName = 'created_by_user_id') {
  const { userId } = getUserContext(req);
  if (isPrivileged(req)) {
    return { clause: '', params: [], nextIdx: paramStartIdx };
  }
  return {
    clause: ` AND ${columnName} = $${paramStartIdx}`,
    params: [userId],
    nextIdx: paramStartIdx + 1,
  };
}

/**
 * Ownership check: returns true if a row may be accessed by the current user.
 * Owner/admin → always true. Regular user → only if ownerUserId matches.
 */
function canAccessRow(req, ownerUserId) {
  if (isPrivileged(req)) return true;
  const { userId } = getUserContext(req);
  return !!userId && userId === ownerUserId;
}

module.exports = {
  getUserContext,
  isPrivileged,
  userScopeFilter,
  canAccessRow,
};
