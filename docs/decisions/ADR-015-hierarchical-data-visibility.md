# ADR-015: Hierarchical Data Visibility and Granular Permissions

**Status:** DECIDED
**Date:** 2026-04-16
**Decided by:** Suer Ay
**Category:** Architecture — Security / Access Control
**Applies to:** ELIZA, LİFFY, LEENA (all ELL systems)

---

## Context

ELL has multiple users with different data access needs:

- **Owner (Suer)** — sees everything, sets permissions for everyone
- **Sales Manager (Elif)** — sees her team (Bengü, future team members) + herself
- **Country Manager (Jude)** — sees his country (Nigeria) + his team (Amaka, future)
- **Sales Rep (Bengü, Amaka)** — sees only own data

Additionally, beyond who-sees-whom, each user has **granular permission needs**:
- Daily email limit varies per user (Bengü 1000, Amaka 500, Elif 2000)
- Elif sees revenue but not expenses
- Country managers see only their country's financials
- Bengü sees no financials at all

The current system has flat role-based access (owner/manager/user). This is insufficient for:
1. Dynamic team hierarchies (Bengü may get her own assistant tomorrow — Amaka under Bengü)
2. Country Manager as distinct from Sales Manager
3. Per-user permission customization (email limits, financial visibility)

## Decision

**Two-layer access control: Role + `reports_to` + granular `permissions` JSON.**

### Layer 1: Roles (4 roles)

| Role | Description | Data scope |
|------|-------------|------------|
| `owner` | System owner (Suer) | All data. Can edit permissions for anyone. |
| `manager` | Sales/Country Manager (Elif, Jude) | Self + recursive team (everyone in `reports_to` tree below them) |
| `sales_rep` | Individual sales contributor (Bengü, Amaka) | Self only + recursive team below (if any) |
| `staff` | Non-sales user (finance, operations, assistant) | Varies by permissions JSON |

**Owner and sales_rep differ only in defaults and UI hints** — both use the same recursive `reports_to` traversal. A sales_rep can have people reporting to them (e.g., Bengü's future assistant).

### Layer 2: `reports_to` Hierarchy

```sql
ALTER TABLE users ADD COLUMN reports_to INTEGER REFERENCES users(id);
CREATE INDEX idx_users_reports_to ON users(reports_to);
```

- `owner` has `reports_to = NULL`
- Everyone else has `reports_to = <manager's user_id>`
- Hierarchy can be N levels deep: Suer → Jude → Amaka → (future assistant)
- Cycles not allowed (enforce in application or via CHECK constraint)

**Recursive CTE pattern for "who can I see":**

```sql
WITH RECURSIVE my_team AS (
  SELECT id FROM users WHERE id = :me
  UNION ALL
  SELECT u.id FROM users u JOIN my_team t ON u.reports_to = t.id
)
SELECT ... FROM some_table WHERE user_id IN (SELECT id FROM my_team)
```

Owner bypass: if role='owner', skip the CTE and return all rows.

### Layer 3: Granular Permissions (JSON)

Add `permissions` JSONB column to `users`:

```sql
ALTER TABLE users ADD COLUMN permissions JSONB DEFAULT '{}';
```

Permission fields:

```json
{
  "daily_email_limit": 1000,
  "country_scope": ["Nigeria"],
  "can_view_revenue": true,
  "can_view_expenses": false,
  "can_view_payments": false,
  "can_view_contracts": true,
  "can_approve_quotes": false,
  "can_create_contracts": false,
  "can_edit_users": false,
  "visible_expos": [],
  "visible_fiscal_years": [2024, 2025, 2026]
}
```

**Empty array means "all" for `visible_expos` and `visible_fiscal_years`.**

### Defaults by Role

When a user is created with a given role, these defaults are applied (admin can override):

| Permission | owner | manager | sales_rep | staff |
|------------|-------|---------|-----------|-------|
| daily_email_limit | 100000 | 2000 | 1000 | 500 |
| can_view_revenue | true | true | false | false |
| can_view_expenses | true | false | false | false |
| can_view_payments | true | false | false | false |
| can_view_contracts | true | true | true (own team) | false |
| can_approve_quotes | true | true (<10% discount) | false | false |
| can_create_contracts | true | false | false | false |
| can_edit_users | true | false | false | false |

**Country Manager** = role='manager' + `country_scope = ['Nigeria']`. The country scope further filters data to that country's expos/contracts.

## Who Can Edit Permissions

- Only `owner` can edit any user's role, `reports_to`, or `permissions`
- Managers cannot edit their team members' permissions (they can see but not modify)
- Staff users cannot see the permission panel at all

## Implementation Priority

Apply this pattern in order:

1. **LİFFY (first)** — Bengü is the first user, isolation bug is already affecting production. Implement now.
2. **ELIZA (second)** — Dashboard data visibility, WhatsApp access, push message scheduling all need this.
3. **LEENA (third)** — Floorplan and operational data, lower immediate urgency.

Shared `users` table means the hierarchy and permissions are set once and apply everywhere.

## Data Tables Affected

Every user-scoped table must apply the visibility filter:

**LİFFY:** leads, persons, affiliations, campaigns, sequences, lists, prospects, action_items, opportunities, quotes, notes, activities, tasks

**ELIZA:** contracts, contract_payments (via user_id or sales_agent lookup), expenses (for financial visibility), dashboard queries

**LEENA:** expo_halls, expo_stands (indirect — via organizer_id + country_scope)

Shared resources (templates, sender_identities, lists) should have a `visibility` column (`private` / `team` / `shared`) that respects the hierarchy when set to 'team'.

## UI Requirements

**Admin panel (owner-only):**
- Add User form: email, password, role dropdown, `reports_to` dropdown (lists all users), permission toggles with role defaults
- Edit User: same fields + permission grid with clear labels ("Can view revenue", "Daily email limit", "Country scope")
- Team Tree view: visual tree showing `reports_to` hierarchy

**Every user's settings page:**
- Shows their own role and `reports_to` (read-only)
- Shows their permissions as a summary (read-only)
- Cannot edit any of these — only owner can

## Consequences

### Positive
- Dynamic N-level hierarchy (Jude → Amaka → future assistant → ...)
- Per-user customization (email limits, financial visibility)
- Country Manager naturally supported (manager + country_scope)
- Works across all three ELL systems with shared users table
- Owner has complete control

### Negative
- Every query that involves user-scoped data needs the recursive CTE — adds complexity
- Permissions JSON is not type-safe (app must validate fields)
- More UI work for admin panel (permission grid)

### Migrations Required
- ELIZA: `ALTER TABLE users ADD COLUMN reports_to INTEGER REFERENCES users(id)`
- ELIZA: `ALTER TABLE users ADD COLUMN permissions JSONB DEFAULT '{}'`
- LİFFY: same two ALTER statements (same users table)
- Backfill: set `reports_to` for existing users (Suer=NULL, Elif reports to Suer, Bengü reports to Elif, etc.)

## Related Decisions

- ADR-006 (Transient agents LİFFY-only access — this ADR supersedes/extends it)
- ADR-011 (Payment authority — permissions.can_view_payments implements this)
- ELL Architecture v2.1 Section 9 (User Tiers)

## Open Questions

1. Should `permissions` fields have a master list in code, or be free-form JSON? Decision: master list in code (type definition), validated on write. Free-form breaks UI.
2. How to handle "temporary" permission grants (e.g., Elif can approve >10% discount for one week)? Out of scope for v1 — implement simple boolean, add TTL later if needed.
3. When a user is moved in the hierarchy (e.g., Amaka moves from Bengü to Jude), what happens to data they created under the old hierarchy? Decision: data stays with the user, visibility follows current hierarchy. Historical access doesn't carry over.

## Implementation Notes

*(Claude Code: add entries here when implementing)*
