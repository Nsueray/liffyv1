/**
 * User scoping helpers for multi-user data isolation.
 *
 * Two systems coexist during transition:
 *
 * LEGACY (team_ids based — used by routes not yet migrated):
 *   - getUserContext, isPrivileged, isManager, userScopeFilter, canAccessRow
 *   - Reads team_ids from req.auth (loaded by authRequired middleware)
 *
 * ADR-015 (recursive CTE — new canonical approach):
 *   - getHierarchicalScope — recursive CTE on reports_to column
 *   - Owner/admin: no filter. Everyone else: self + all descendants.
 *   - Routes should migrate to this incrementally.
 *
 * Auth shapes supported:
 *   - Legacy local middleware  → req.auth = { user_id, organizer_id, role }
 *   - Shared middleware/auth.js → req.user = { id, user_id, organizer_id, role }
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared context extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract normalized auth context from a request.
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
 * True if the user is a manager.
 */
function isManager(req) {
  const { role } = getUserContext(req);
  return role === 'manager';
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY: team_ids based scope (kept for backward compat during migration)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an AND-clause fragment + params for filtering by a user-scoped column.
 * Uses team_ids array loaded by authRequired middleware.
 *
 * @deprecated Use getHierarchicalScope instead (ADR-015).
 */
function userScopeFilter(req, paramStartIdx, columnName = 'created_by_user_id') {
  if (isPrivileged(req)) {
    return { clause: '', params: [], nextIdx: paramStartIdx };
  }

  const { userId, teamIds } = getUserContext(req);

  if (isManager(req) && teamIds.length > 0) {
    const allIds = [userId, ...teamIds];
    const placeholders = allIds.map((_, i) => `$${paramStartIdx + i}`).join(', ');
    return {
      clause: ` AND ${columnName} IN (${placeholders})`,
      params: allIds,
      nextIdx: paramStartIdx + allIds.length,
    };
  }

  return {
    clause: ` AND ${columnName} = $${paramStartIdx}`,
    params: [userId],
    nextIdx: paramStartIdx + 1,
  };
}

/**
 * Ownership check: returns true if a row may be accessed by the current user.
 * @deprecated Use getHierarchicalScope for query-level filtering instead.
 */
function canAccessRow(req, ownerUserId) {
  if (isPrivileged(req)) return true;
  const { userId, teamIds } = getUserContext(req);
  if (!userId) return false;
  if (userId === ownerUserId) return true;
  if (isManager(req) && teamIds.includes(ownerUserId)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// ADR-015: Recursive CTE based scope (canonical approach)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hierarchical data visibility using recursive CTE on users.reports_to.
 *
 * Returns an AND-clause that filters `userIdColumn` to the user's team:
 *   self + all descendants in the reports_to tree.
 *
 * Owner/admin: returns empty clause (sees all).
 *
 * Example:
 *   const scope = getHierarchicalScope(req, 'c.created_by_user_id', 2);
 *   const sql = `SELECT * FROM campaigns c WHERE c.organizer_id = $1 ${scope.sql}`;
 *   const params = [orgId, ...scope.params];
 *
 * @param {import('express').Request} req
 * @param {string} userIdColumn — fully qualified column, e.g. 'lists.created_by_user_id'
 * @param {number} startParamIndex — next $N placeholder to use
 * @returns {{ sql: string, params: any[], nextIndex: number }}
 */
function getHierarchicalScope(req, userIdColumn, startParamIndex) {
  if (isPrivileged(req)) {
    return { sql: '', params: [], nextIndex: startParamIndex };
  }

  const { userId } = getUserContext(req);

  return {
    sql: `AND ${userIdColumn} IN (
      WITH RECURSIVE my_team AS (
        SELECT id FROM users WHERE id = $${startParamIndex}
        UNION ALL
        SELECT u.id FROM users u JOIN my_team t ON u.reports_to = t.id
      )
      SELECT id FROM my_team
    )`,
    params: [userId],
    nextIndex: startParamIndex + 1,
  };
}

/**
 * Build a visibility-aware scope clause for resources with a visibility column.
 *
 * Logic:
 *   - visibility = 'shared' → everyone in the org sees it
 *   - visibility = 'team'   → user + descendants see it (hierarchy)
 *   - visibility = 'private' OR NULL → only the owner sees it (hierarchy still)
 *   - owner_user_id IS NULL → only owner/admin see it (legacy rows)
 *
 * Owner/admin: returns empty clause (sees all).
 *
 * @param {import('express').Request} req
 * @param {string} ownerColumn — e.g. 'lists.created_by_user_id'
 * @param {string} visColumn — e.g. 'lists.visibility'
 * @param {number} startParamIndex
 * @returns {{ sql: string, params: any[], nextIndex: number }}
 */
function getVisibilityScope(req, ownerColumn, visColumn, startParamIndex) {
  if (isPrivileged(req)) {
    return { sql: '', params: [], nextIndex: startParamIndex };
  }

  const { userId } = getUserContext(req);
  const p = startParamIndex;

  return {
    sql: `AND (
      ${visColumn} = 'shared'
      OR ${ownerColumn} IN (
        WITH RECURSIVE my_team AS (
          SELECT id FROM users WHERE id = $${p}
          UNION ALL
          SELECT u.id FROM users u JOIN my_team t ON u.reports_to = t.id
        )
        SELECT id FROM my_team
      )
    )`,
    params: [userId],
    nextIndex: p + 1,
  };
}

/**
 * Upward visibility scope for resources where "private" means
 * creator + everyone ABOVE in the hierarchy can see.
 *
 * Use case: email_templates, sender_identities — a manager can see
 * their subordinate's private templates (because the manager is above).
 *
 * Logic:
 *   - visibility = 'public' → everyone in the org sees it
 *   - visibility = 'private' → only the creator, OR anyone who is an
 *     ancestor of the creator (walks UP the reports_to chain from
 *     the creator and checks if the current user is in that chain).
 *
 * Owner/admin: returns empty clause (sees all).
 *
 * @param {import('express').Request} req
 * @param {string} ownerColumn — e.g. 'et.created_by_user_id'
 * @param {string} visColumn — e.g. 'et.visibility'
 * @param {number} startParamIndex
 * @returns {{ sql: string, params: any[], nextIndex: number }}
 */
function getUpwardVisibilityScope(req, ownerColumn, visColumn, startParamIndex) {
  if (isPrivileged(req)) {
    return { sql: '', params: [], nextIndex: startParamIndex };
  }

  const { userId } = getUserContext(req);
  const p = startParamIndex;

  // Walk UP from the creator: start at creator, follow reports_to upward.
  // If the current user appears in that chain → they are above the creator → allowed.
  return {
    sql: `AND (
      ${visColumn} = 'shared'
      OR ${ownerColumn} = $${p}
      OR $${p} IN (
        WITH RECURSIVE upward AS (
          SELECT reports_to FROM users WHERE id = ${ownerColumn}
          UNION ALL
          SELECT u.reports_to FROM users u JOIN upward up ON u.id = up.reports_to WHERE up.reports_to IS NOT NULL
        )
        SELECT reports_to FROM upward WHERE reports_to IS NOT NULL
      )
    )`,
    params: [userId],
    nextIndex: p + 1,
  };
}

/**
 * Async row-level access check using recursive CTE on reports_to.
 * Use for single-row ownership checks (e.g., loadOwnedCampaign).
 *
 * @param {import('express').Request} req
 * @param {string} ownerUserId — the user_id that owns the row
 * @returns {Promise<boolean>}
 */
async function canAccessRowHierarchical(req, ownerUserId) {
  if (isPrivileged(req)) return true;
  const { userId } = getUserContext(req);
  if (!userId || !ownerUserId) return false;
  if (userId === ownerUserId) return true;

  const db = require('../db');
  const r = await db.query(
    `WITH RECURSIVE my_team AS (
       SELECT id FROM users WHERE id = $1
       UNION ALL
       SELECT u.id FROM users u JOIN my_team t ON u.reports_to = t.id
     )
     SELECT 1 FROM my_team WHERE id = $2 LIMIT 1`,
    [userId, ownerUserId]
  );
  return r.rows.length > 0;
}

module.exports = {
  // Shared
  getUserContext,
  isPrivileged,
  isManager,
  // Legacy (deprecated — use ADR-015 functions)
  userScopeFilter,
  canAccessRow,
  // ADR-015 (canonical)
  getHierarchicalScope,
  getVisibilityScope,
  getUpwardVisibilityScope,
  canAccessRowHierarchical,
};
