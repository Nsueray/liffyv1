# MINING ENGINE REFACTOR — MASTER PLAN v2

**(Claude + ChatGPT + Gemini Consensus)**

## Vision

User enters URL → chooses Free or AI → System does everything.
One engine. One normalizer. One aggregation layer. Lego miners.

---

## Current State (BROKEN)

```
UI → processMiningJob() → switch(mode)
  → quick  → runQuickMining()   → httpBasicMiner only
  → full   → runFullMining()    → 3 miners + pagination + dedup + save + aggregation
  → ai     → runAIMining()      → aiMiner + pagination + save + aggregation

SuperMiner (UNUSED in production):
  superMinerEntry → flowOrchestrator.executeJob() → SmartRouter → miners → Redis → aggregateV2
```

**Problems:**
- 2 parallel pipelines (miningService vs flowOrchestrator)
- 3 normalizers (directoryMiner, orchestrator.normalizeResult, backend/normalizer)
- 600 lines duplicated (pagination, dedup, save logic in both)
- flowOrchestrator never called from UI
- Redis dependency blocks simple deployment

---

## Target State

```
UI → processMiningJob(job)
  → [file] → fileOrchestrator (unchanged)
  → [url]  → superMinerEntry.runMiningJob(job)
               ├─ flowOrchestrator.executeJob(job)
               │    ├─ SmartRouter decides miners + order
               │    ├─ Try miner A, B, C, D... (all plugins)
               │    ├─ Merge raw results
               │    └─ Return merged contacts
               ├─ Canonical normalizer (backend/services/normalizer/)
               ├─ aggregationTrigger → persons + affiliations
               ├─ saveMiningResults → mining_results
               └─ updateJobStatus → mining_jobs
```

**Two modes only:**
- **free** → deterministic miners (playwrightTableMiner, directoryMiner, documentMiner, httpBasicMiner)
- **ai** → aiMiner first, then deterministic miners as fallback/supplement

**Key decisions (AI Council consensus):**
- NO new `unifiedMiningEngine.js` file — `superMinerEntry.js` becomes the "fat wrapper" (Gemini recommendation)
- Feature flag (`USE_UNIFIED_ENGINE`) for safe production rollout (Claude + ChatGPT consensus)
- Redis optional FIRST, before any routing changes (Claude + Gemini consensus)
- File pipeline completely untouched (all 3 AIs agree)

---

## 10-STEP EXECUTION PLAN

### Step 1 — Redis Optional ✅ DONE

**Source:** Claude (Phase 1.1) — all 3 AIs agree this is the blocker

**Goal:** flowOrchestrator works without Redis. No crash, graceful fallback.

**Files to change:**
- `flowOrchestrator.js` constructor — try/catch Redis services, null if fail
- `flowOrchestrator.js` methods — null checks on eventBus, intermediateStorage, htmlCache
- `resultAggregator.js` — aggregateV1 falls back to aggregateSimple when no Redis
- `eventBus.js` — constructor fail → `this.enabled = false`, no-op publish/subscribe
- `intermediateStorage.js` — constructor fail → `this.enabled = false`, no-op get/set
- `superMiner/index.js` — `initialize()` logs warning instead of crashing on Redis fail

**Test:** `createFlowOrchestrator(db)` works without Redis env vars.

**Rollback:** None needed — only makes things MORE resilient.

---

### Step 2 — Remove SUPERMINER_ENABLED Flag ✅ DONE

**Source:** ChatGPT (Phase 2)

**Goal:** superMinerEntry always uses flowOrchestrator. No legacy fallback path.

**Files changed:**
- `superMiner/index.js` — removed `SUPERMINER_ENABLED` const + all guards, `shouldUseSuperminer()` always returns true
- `superMinerEntry.js` — removed legacy fallback branches + `runLegacyMining()` function
- `worker.js` — removed `SUPERMINER_ENABLED` check from `initSuperMiner()` + `shouldUseSuperMiner()`

**Test:** `superMinerEntry.runMiningJob()` always goes to orchestrator path.

**Rollback:** Re-add flag if needed.

---

### Step 3 — Route processMiningJob → superMinerEntry ✅ DONE

**Source:** ChatGPT + Gemini (direct routing, no extra layer)

**Goal:** All URL mining goes through superMinerEntry → flowOrchestrator.

**Files changed:**
- `miningService.js` — added `require('./superMiner/services/superMinerEntry')` import, added `USE_UNIFIED_ENGINE` feature flag routing before legacy `switch(mode)`. Default: ON (`!== 'false'`).
- Legacy `switch(mode)` code stays as fallback (not deleted yet — Step 8).

**Feature flag:** `USE_UNIFIED_ENGINE` — default ON. Set `USE_UNIFIED_ENGINE=false` in Render env to instant-rollback to legacy path.

**Test:** `USE_UNIFIED_ENGINE` unset → unified engine active. Set to `'false'` → legacy path.

**Rollback:** Set `USE_UNIFIED_ENGINE=false` → instant rollback via Render env var.

---

### Step 4 — Save + Aggregation in superMinerEntry ⬅️ CURRENT

**Source:** Gemini (superMinerEntry as fat wrapper instead of new file)

**Goal:** superMinerEntry handles the complete post-mining pipeline.

**Move from miningService.js to superMinerEntry.js:**
- `saveMergedResults()` (miningService lines 625-687)
- `updateJobStatus()` (miningService lines 689-715)
- `runShadowModeFromMergedResult()` → rename to `runAggregation()` (miningService lines 158-213)

**superMinerEntry.runMiningJob flow:**
```javascript
async function runMiningJob(job, db) {
  const orchestrator = getOrCreateOrchestrator(db);

  // 1. Mine (flowOrchestrator handles miners + merge + pagination)
  const result = await orchestrator.executeJob(job);

  // 2. Aggregate (canonical normalizer → persons + affiliations)
  await runAggregation(job, result);

  // 3. Save (mining_results INSERT/UPDATE)
  await saveMiningResults(job, result.contacts);

  // 4. Job status
  await updateJobStatus(job, result, Date.now() - startTime);

  return result;
}
```

**Test:** Full pipeline: mine → normalize → aggregate → save → job status update.

**Rollback:** Feature flag from Step 3 still works.

---

### Step 5 — Flow2 Simplify/Disable

**Source:** ChatGPT (Phase 3.2)

**Goal:** `executeFlow2` (deep crawl + Redis) disabled or simplified for now.

**Files to change:**
- `flowOrchestrator.js` `executeJob()` — skip Flow2 when Redis unavailable
- `shouldTriggerFlow2()` — return false when no Redis

**Rationale:** Flow2 depends heavily on Redis intermediateStorage. Production path should be Flow1 only until Redis is optionally available.

**Test:** Mining completes without Flow2 triggering.

**Rollback:** Flow2 was already rarely triggered.

---

### Step 6 — Mode Mapping: quick/full/ai → free/ai

**Source:** ChatGPT (Phase 5), User vision doc

**Goal:** Backend maps old modes to new modes. UI change is FUTURE (not this refactor).

```javascript
function mapMode(mode) {
  switch(mode) {
    case 'quick': return 'free';
    case 'full': return 'free';
    case 'ai': return 'ai';
    default: return 'free';
  }
}
```

**SmartRouter behavior:**
- **free:** Run all deterministic miners, merge results
- **ai:** aiMiner first, deterministic miners supplement

**Test:** All 3 old modes produce correct results through new engine.

**Rollback:** Mode mapping is trivial to revert.

---

### Step 7 — urlMiner + miningWorker DB Write Removal

**Source:** ChatGPT (Phase 4) + Claude — done AFTER legacy cleanup

**Goal:** All miners follow strict RAW-only contract. No DB writes in miners.

**Files to change:**
- `urlMiner.js` — remove INSERT to mining_results, prospects, lists, list_members. Return results only.
- `miningWorker.js` — remove `saveResultsToDb()`, `runShadowModeNormalization()`. Return results only.

**Why after cleanup:** These files are still used by legacy path. Only safe to modify after legacy is fully off.

**Test:** Miners return data, don't write to DB. Pipeline still works end-to-end.

**Rollback:** Git revert on specific files.

---

### Step 8 — Legacy Function Deletion (miningService slim down)

**Source:** Claude (Phase 3)

**Goal:** miningService.js goes from 916 lines to ~200 lines.

**Delete from miningService.js:**
- `runQuickMining()` (lines 311-321)
- `runFullMining()` (lines 327-458)
- `runAIMining()` (lines 464-565)
- `saveAIResults()` (lines 571-623) — merged into saveMergedResults in Step 4
- `detectJobPagination()` (lines 224-266)
- `deduplicateContacts()` (lines 274-298)
- `sleep()` (lines 300-302)
- Miner wrapper objects (lines 46-144)
- `saveMergedResults()` (moved to superMinerEntry in Step 4)
- `updateJobStatus()` (moved to superMinerEntry in Step 4)
- `runShadowModeFromMergedResult()` (moved to superMinerEntry in Step 4)

**Keep in miningService.js:**
- `processMiningJob()` — thin router (file → fileOrchestrator, url → superMinerEntry)
- `normalizeJobType()`
- `isPdfUrl()`
- `downloadPdfFromUrl()`

**Also delete:**
- `resultMerger.js` — duplicate of `flowOrchestrator.mergeResults()`
- Remove `USE_UNIFIED_ENGINE` feature flag (no longer needed)

**PREREQUISITE:** Only do this after Step 3-4 have been running in production for 24+ hours without issues.

**Test:** Full regression — URL mining, file mining, PDF URL, all modes.

**Rollback:** Git revert (this is the riskiest step — hence the 24hr prerequisite).

---

### Step 9 — directoryMiner Integration

**Source:** All 3 AIs agree — last step

**Goal:** Add directoryMiner as a new lego piece to the unified engine.

**Sub-steps:**

**9.1** Copy `liffy-local-miner/miners/directoryMiner.js` → `backend/services/urlMiners/directoryMiner.js`
- Remove `require('../utils/normalize')` import
- Return raw extraction data (no normalizeResult call)
- Keep Playwright lifecycle internal

**9.2** Create `backend/services/urlMiners/directoryMinerAdapter.js` (~60 lines)
- Wraps `runDirectoryMiner(page, url, config)` → `mine(job)` interface
- Manages Playwright browser lifecycle
- Returns `{ status, contacts, emails, meta }`

**9.3** Register in `flowOrchestrator.loadMiners()` (try/catch, ~10 lines)

**9.4** Add directory URL patterns to SmartRouter
```javascript
const DIRECTORY_PATTERNS = [
  'yellowpages', 'yell.com', 'goldenpages', 'ghanayello',
  'yelp.com', 'justdial', 'europages', 'thomasnet',
  'kompass', 'hotfrog', 'cylex'
];
```

**9.5** Add to `executionPlanBuilder` if directory site detected

**9.6** Test: GhanaYello URL → directoryMiner triggered → results in persons table

**Rollback:** try/catch in loadMiners means directoryMiner failure doesn't crash system.

---

### Step 10 — UI Simplification (FUTURE — not this refactor)

**Goal:** UI shows only Free / AI Powered (remove Quick mode).

This is a frontend-only change in liffy-ui. Backend already handles mode mapping from Step 6.

Not blocking. Can be done anytime after engine refactor is stable.

---

## FINAL ARCHITECTURE

```
miningService.js (thin router, ~200 lines)
  ├─ [file] → fileOrchestrator (unchanged)
  └─ [url] → superMinerEntry.js (fat wrapper)
               ├─ flowOrchestrator.executeJob()
               │    ├─ SmartRouter → miner selection
               │    ├─ loadMiners() registry:
               │    │   ├─ playwrightTableMiner
               │    │   ├─ aiMiner
               │    │   ├─ documentMiner
               │    │   ├─ directoryMiner (NEW)
               │    │   ├─ httpBasicMiner
               │    │   └─ (future miners...)
               │    ├─ Pagination (paginationHandler)
               │    ├─ mergeResults()
               │    └─ normalizeResult() (field mapping only)
               │
               ├─ runAggregation()
               │    ├─ normalizeMinerOutput() ← CANONICAL NORMALIZER
               │    │   ├─ emailExtractor
               │    │   ├─ nameParser
               │    │   ├─ companyResolver
               │    │   └─ countryNormalizer
               │    └─ aggregationTrigger.process()
               │        └─ persons + affiliations UPSERT
               │
               ├─ saveMiningResults() → mining_results INSERT/UPDATE
               └─ updateJobStatus() → mining_jobs UPDATE
```

---

## ROLLBACK STRATEGY

| Step | Rollback Method | Speed |
|------|----------------|-------|
| 1 (Redis optional) | N/A — only adds resilience | — |
| 2 (Remove flag) | Re-add SUPERMINER_ENABLED | 5 min |
| 3 (Routing) | `USE_UNIFIED_ENGINE=false` env var | 10 sec |
| 4 (Save/Aggregate move) | Feature flag from Step 3 | 10 sec |
| 5 (Flow2 disable) | Re-enable in code | 5 min |
| 6 (Mode mapping) | Trivial revert | 5 min |
| 7 (Miner DB write removal) | Git revert specific files | 10 min |
| 8 (Legacy deletion) | Git revert | 10 min |
| 9 (directoryMiner) | try/catch = auto-safe | 0 sec |
| 10 (UI) | Frontend revert | 5 min |

---

## TIMELINE

| Step | Estimated Time | Day |
|------|---------------|-----|
| 1. Redis optional | 1-2 hours | Day 1 |
| 2. Remove SUPERMINER flag | 30 min | Day 1 |
| 3. Route to superMinerEntry | 1 hour | Day 1 |
| 4. Save + Aggregation move | 2 hours | Day 1 |
| 5. Flow2 simplify | 30 min | Day 1 |
| 6. Mode mapping | 30 min | Day 2 |
| 7. Miner DB write removal | 2 hours | Day 2 |
| 8. Legacy deletion | 1 hour | Day 2 |
| 9. directoryMiner | 2 hours | Day 3 |
| 10. UI (future) | 1 hour | Future sprint |

**Total: ~11 hours across 3 days**

---

## CRITICAL RULES

1. File mining pipeline is **UNTOUCHED** — fileOrchestrator, fileMiner, extractors stay as-is
2. No miner code modified — aiMiner, playwrightTableMiner, documentMiner internal code unchanged
3. Canonical normalizer is the **ONLY** normalizer — `backend/services/normalizer/`
4. `aggregationTrigger` interface unchanged — `process({jobId, organizerId, normalizationResult, metadata})`
5. Every step is independently testable and reversible
6. directoryMiner original (local-miner) NOT modified — copy to backend, adapt there
7. No new files except: directoryMiner copy + adapter (Step 9). `superMinerEntry.js` is expanded, not replaced.
8. Step 8 (legacy deletion) only after 24hr production stability

---

## TEST MATRIX (Per Step)

| Test | URL Type | Expected |
|------|----------|----------|
| T1 | Basic exhibition site (free) | playwrightTableMiner + httpBasic results |
| T2 | Exhibition site (ai) | aiMiner results |
| T3 | Paginated site | Multiple pages mined |
| T4 | PDF URL | fileOrchestrator handles |
| T5 | File upload | fileOrchestrator handles |
| T6 | Directory site (after Step 9) | directoryMiner results |

**Check after each test:**
- [ ] mining_results rows created
- [ ] persons UPSERT correct
- [ ] affiliations UPSERT correct
- [ ] mining_jobs status = completed
- [ ] No duplicate aggregation (persons count stable)
