# E1 Legacy Cleanup — prospects Table Removal Analysis

**Date:** 2026-04-22
**Status:** Analysis complete, implementation NOT started

---

## Executive Summary

The `prospects` table (25,482 rows) is a **legacy Phase 2-3 table** being gradually replaced by the canonical `persons` + `affiliations` architecture. It currently has **8 active read/write paths** across the backend. Most write paths are dual-write (prospects + persons/affiliations).

**Goal:** Remove all dual-writes, migrate FK references, drop the prospects table.

---

## Current State — Backfill Completion

| Table | Total Rows | Missing person_id | Missing prospect_id |
|-------|-----------|-------------------|---------------------|
| campaign_recipients | 15,883 | **627** (3.9%) | 0 |
| list_members | 31,166 | **0** (100% done) | 0 |

**list_members: READY** — 100% person_id backfill complete.
**campaign_recipients: ALMOST READY** — 627 rows (3.9%) still missing person_id. Need to run backfill script.

---

## Foreign Key Constraints on prospects

| Table | Constraint | Column | On Delete |
|-------|-----------|--------|-----------|
| list_members | list_members_prospect_id_fkey | prospect_id | CASCADE |
| verification_queue | verification_queue_prospect_id_fkey | prospect_id | CASCADE |

**Note:** `campaign_recipients.prospect_id` has NO FK constraint — just a code reference.

---

## File-by-File Dependency Map

### A. prospects.js — Direct Endpoints
| Endpoint | Type | Notes |
|----------|------|-------|
| `POST /api/prospects` | WRITE | Legacy batch insert, no dual-write |
| `GET /api/prospects` | READ | Actually queries prospect_intents + persons (NOT prospects table!) |

### B. leads.js — Dual-Write Path (MAJOR)
| Endpoint | Type | Notes |
|----------|------|-------|
| `GET /api/leads` | READ | Reads FROM prospects directly (legacy) |
| `POST /api/leads/import` | WRITE | Complex dual-write: prospects + persons + affiliations + list_members |
| `POST /api/leads/:id/tags` | WRITE | Updates prospects.tags only |
| `POST /api/leads/bulk-tags` | WRITE | Updates prospects.tags only |

### C. verification.js + verificationService.js — Dual-Write
| Function | Type | Notes |
|----------|------|-------|
| `POST /api/verification/verify-single` | WRITE | Updates BOTH persons + prospects verification_status |
| `verificationService.queueEmails()` | WRITE | Looks up prospect_id, stores in verification_queue |
| `verificationService.processOneItem()` | WRITE | Updates BOTH persons + prospects verification_status |

### D. campaigns.js — Hybrid Resolution (CRITICAL)
| Path | Type | Notes |
|------|------|-------|
| Path A (canonical) | READ | Uses person_id from list_members, LEFT JOIN prospects for fallback data |
| Path B (legacy) | READ | INNER JOIN prospects when person_id IS NULL, matches to persons via email |
| INSERT | WRITE | campaign_recipients with BOTH prospect_id + person_id |

### E. lists.js — Dual-Write (10+ endpoints)
| Operation | Type | Notes |
|-----------|------|-------|
| Add members | WRITE | SELECT/INSERT/UPDATE prospects + persons + affiliations |
| Bulk add | WRITE | Same dual-write pattern |
| List queries | READ | SELECT from prospects (multiple endpoints) |
| Inline add | WRITE | INSERT prospects + persons + affiliations |

### F. miningResults.js — Dual-Write
| Operation | Type | Notes |
|-----------|------|-------|
| List creation from results | WRITE | SELECT/INSERT prospects + persons + affiliations + list_members |

### G. urlMiner.js — Legacy
| Operation | Type | Notes |
|-----------|------|-------|
| Exhibitor mining | WRITE | SELECT/INSERT prospects directly (no dual-write) |

---

## Recommended Removal Order

### Phase 1: Safe Reads (LOW RISK)
1. **leads.js GET /api/leads** — Replace with persons query
2. **prospects.js POST** — Low usage, remove or deprecate

### Phase 2: Tag Operations (LOW RISK)
3. **leads.js POST tags** — Move tags to persons.meta or remove
4. **leads.js POST bulk-tags** — Same

### Phase 3: Verification (MEDIUM RISK)
5. **verification.js + verificationService.js** — Remove prospect_id lookups + writes
   - Prerequisite: 100% person_id in verification_queue
   - After: verification only writes to persons

### Phase 4: List Members (MEDIUM-HIGH RISK)
6. **lists.js** — Remove all prospects SELECT/INSERT/UPDATE paths
   - Prerequisite: list_members.person_id 100% backfill ✅ (DONE)
   - After: write to persons + affiliations only
   - Migration: ALTER list_members DROP prospect_id (after campaigns.js cleanup)

### Phase 5: Campaign Resolution (HIGH RISK)
7. **campaigns.js** — Remove Path B (legacy fallback)
   - Prerequisite: campaign_recipients.person_id 100% backfill (627 remaining)
   - After: resolution uses person_id only
   - Migration: ALTER campaign_recipients DROP prospect_id

### Phase 6: Mining Ingestion (MEDIUM RISK)
8. **miningResults.js** — Remove prospects dual-write in list creation
   - After: write to persons + affiliations only

### Phase 7: Legacy Mining (LOW PRIORITY)
9. **urlMiner.js** — Deprecate or refactor to persons architecture

### Phase 8: Final Cleanup
10. Drop prospects table
11. Remove prospects.js route
12. Clean up backfill scripts

---

## Pre-Requisites Before Starting

1. **Run backfill:** Fix 627 campaign_recipients with missing person_id
2. **Verify:** No NULL person_id in list_members (CONFIRMED: 0 missing)
3. **Verify:** All campaign resolve paths work with person_id only
4. **Migration plan:** ALTER TABLE list_members DROP COLUMN prospect_id after Phase 4
5. **Migration plan:** ALTER TABLE campaign_recipients DROP COLUMN prospect_id after Phase 5
6. **Migration plan:** DROP TABLE verification_queue prospect_id column after Phase 3

---

## Risk Matrix

| Component | Risk | Impact if Broken | Mitigation |
|-----------|------|-----------------|-----------|
| Leads GET | LOW | UI shows empty list | Replace with persons query |
| Tags | LOW | Tags not updated | Move to persons.meta |
| Verification | MEDIUM | Verification status not saved | Test thoroughly |
| List members | MEDIUM-HIGH | List creation fails | Test all add-member paths |
| Campaign resolve | **HIGH** | Campaigns can't send | Keep Path B until 100% backfill |
| Mining results | MEDIUM | Mining import fails | Test import workflow |
| urlMiner | LOW | Legacy miner breaks | Not on critical path |

---

## Estimated Effort

- Phase 1-2: ~2 hours (safe, straightforward)
- Phase 3: ~3 hours (verification dual-write, needs testing)
- Phase 4: ~4 hours (lists.js has 10+ endpoints, complex)
- Phase 5: ~3 hours (campaigns.js critical path, careful testing)
- Phase 6-7: ~2 hours (mining paths)
- Phase 8: ~1 hour (final drop + cleanup)
- **Total: ~15 hours across multiple sessions**
