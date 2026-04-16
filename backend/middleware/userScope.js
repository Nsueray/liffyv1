/**
 * User scoping helpers for multi-user data isolation.
 *
 * Policy (hierarchical):
 *   - role === 'owner' or 'admin'  → sees every row within their organizer
 *   - role === 'manager'           → sees own rows + rows of team members (direct reports)
 *   - role === 'user' (or other)   → only their own rows
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
 * @returns {{ userId: string|null, organizerId: string|null, role: string|null, teamIds: string[] }}
 */
function getUserContext(req) {
  const u = req.user || req.auth || {};
  return {
    userId: u.id || u.user_id || null,
    organizerId: u.organizer_id || null,
    role: u.role || null,
    teamIds: u.team_ids || [],
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
 * True if the user is a manager (sees own + team rows).
 */
function isManager(req) {
  const { role } = getUserContext(req);
  return role === 'manager';
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
 * For managers: column IN (self + team_ids).
 * For regular users: column = self.
 *
 * @param {import('express').Request} req
 * @param {number} paramStartIdx — the next $N placeholder to use
 * @param {string} columnName — fully qualified column name, e.g. "c.created_by_user_id"
 * @returns {{ clause: string, params: any[], nextIdx: number }}
 */
function userScopeFilter(req, paramStartIdx, columnName = 'created_by_user_id') {
  if (isPrivileged(req)) {
    return { clause: '', params: [], nextIdx: paramStartIdx };
  }

  const { userId, teamIds } = getUserContext(req);

  if (isManager(req) && teamIds.length > 0) {
    // Manager sees own + team: column IN ($N, $N+1, ...)
    const allIds = [userId, ...teamIds];
    const placeholders = allIds.map((_, i) => `$${paramStartIdx + i}`).join(', ');
    return {
      clause: ` AND ${columnName} IN (${placeholders})`,
      params: allIds,
      nextIdx: paramStartIdx + allIds.length,
    };
  }

  // Regular user (or manager with no team) — own rows only
  return {
    clause: ` AND ${columnName} = $${paramStartIdx}`,
    params: [userId],
    nextIdx: paramStartIdx + 1,
  };
}

/**
 * Ownership check: returns true if a row may be accessed by the current user.
 * Owner/admin → always true. Manager → if ownerUserId is self or team member.
 * Regular user → only if ownerUserId matches.
 */
function canAccessRow(req, ownerUserId) {
  if (isPrivileged(req)) return true;
  const { userId, teamIds } = getUserContext(req);
  if (!userId) return false;
  if (userId === ownerUserId) return true;
  if (isManager(req) && teamIds.includes(ownerUserId)) return true;
  return false;
}

module.exports = {
  getUserContext,
  isPrivileged,
  isManager,
  userScopeFilter,
  canAccessRow,
};
