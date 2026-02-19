/**
 * LIFFY Aggregation Trigger
 * Phase 1 → Phase 2 Bridge: Shadow Mode + Persist Mode
 *
 * Receives normalized candidates from the normalizer and:
 *   - AGGREGATION_PERSIST=true  → UPSERT to persons + affiliations tables
 *   - AGGREGATION_PERSIST=false → Log only (shadow mode, default)
 *   - DISABLE_SHADOW_MODE=true  → Do nothing
 *
 * CRITICAL RULES:
 *   - Only this module writes to persons and affiliations tables
 *   - Aggregation errors MUST NOT break the mining pipeline
 *   - All writes happen in a single transaction per job
 *   - Existing mining_results flow is NEVER affected
 */

const pool = require('../db');

const LOG_PREFIX = '[AGGREGATION]';
const SHADOW_PREFIX = '[SHADOW_MODE_DATA]';
const VERBOSE = process.env.SHADOW_MODE_VERBOSE === 'true';

/**
 * Is the aggregation trigger enabled at all?
 */
function isEnabled() {
  return process.env.DISABLE_SHADOW_MODE !== 'true';
}

/**
 * Should we persist to DB?
 */
function isPersistEnabled() {
  return process.env.AGGREGATION_PERSIST === 'true';
}

/**
 * Process normalized candidates.
 * Persists to persons + affiliations if AGGREGATION_PERSIST=true,
 * otherwise logs only (shadow mode).
 *
 * @param {Object} options
 * @param {string} options.jobId - Mining job UUID
 * @param {string} options.organizerId - Organizer UUID (multi-tenant scope)
 * @param {Object} options.normalizationResult - Output from normalizeMinerOutput()
 * @param {Object} [options.metadata] - Additional context
 * @returns {Promise<Object>} Processing result
 */
async function aggregate({ jobId, organizerId, normalizationResult, metadata = {} }) {
  if (!isEnabled()) {
    return { processed: false, reason: 'disabled', timestamp: new Date().toISOString() };
  }

  const candidates = normalizationResult.candidates || [];
  const candidateCount = candidates.length;

  // Always log summary
  logSummary(jobId, organizerId, normalizationResult, metadata);

  if (!isPersistEnabled()) {
    // Shadow mode — log only, no DB writes
    logCandidates(jobId, candidates);
    return {
      processed: true,
      persisted: false,
      candidateCount,
      timestamp: new Date().toISOString(),
    };
  }

  // Persist mode — write to persons + affiliations
  if (!organizerId) {
    console.error(`${LOG_PREFIX} ERROR: organizerId is required for persist mode (job ${jobId})`);
    return { processed: false, error: 'missing organizerId', timestamp: new Date().toISOString() };
  }

  if (candidateCount === 0) {
    console.log(`${LOG_PREFIX} No candidates to persist for job ${jobId}`);
    return { processed: true, persisted: true, persons: 0, affiliations: 0, timestamp: new Date().toISOString() };
  }

  return await persistCandidates(jobId, organizerId, candidates, metadata);
}

/**
 * Persist candidates to persons + affiliations in a single transaction.
 *
 * For each candidate:
 *   1. UPSERT person by (organizer_id, LOWER(email))
 *   2. For each affiliation: UPSERT by (organizer_id, person_id, LOWER(company_name))
 *
 * Constitution rules enforced:
 *   - "affiliations are additive, never overwritten"
 *   - COALESCE preserves existing data, only fills NULLs or upgrades confidence
 *   - "same email + same company + new info = enrichment, not replacement"
 */
async function persistCandidates(jobId, organizerId, candidates, metadata) {
  const client = await pool.connect();
  let personsUpserted = 0;
  let affiliationsUpserted = 0;

  try {
    await client.query('BEGIN');

    for (const candidate of candidates) {
      if (!candidate.email) continue;

      // 1. UPSERT person
      const personRes = await client.query(`
        INSERT INTO persons (organizer_id, email, first_name, last_name)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (organizer_id, LOWER(email))
        DO UPDATE SET
          first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), persons.first_name),
          last_name  = COALESCE(NULLIF(EXCLUDED.last_name, ''), persons.last_name),
          updated_at = NOW()
        RETURNING id
      `, [
        organizerId,
        candidate.email.trim().toLowerCase(),
        candidate.first_name || null,
        candidate.last_name || null,
      ]);

      const personId = personRes.rows[0].id;
      personsUpserted++;

      // 2. UPSERT affiliations
      const affiliations = candidate.affiliations || [];
      for (const aff of affiliations) {
        const hasCompany = aff.company_name && aff.company_name.trim().length > 0 && !aff.company_name.includes('@');
        const companyName = hasCompany ? aff.company_name.trim() : null;

        // Build source_type and source_ref from extraction_meta
        const sourceType = metadata.mining_mode || metadata.strategy || 'mining';
        const sourceRef = candidate.extraction_meta?.source_url || null;
        const confidence = typeof aff.confidence === 'number' ? aff.confidence : null;

        // Raw payload for audit trail
        const raw = {
          extraction_meta: candidate.extraction_meta || null,
          original_affiliation: aff,
        };

        if (hasCompany) {
          // UPSERT: same person + same company = enrichment
          await client.query(`
            INSERT INTO affiliations (
              organizer_id, person_id, company_name, position,
              country_code, city, website, phone,
              source_type, source_ref, mining_job_id, confidence, raw
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT (organizer_id, person_id, LOWER(company_name))
              WHERE company_name IS NOT NULL
            DO UPDATE SET
              position     = COALESCE(NULLIF(EXCLUDED.position, ''), affiliations.position),
              country_code = COALESCE(NULLIF(EXCLUDED.country_code, ''), affiliations.country_code),
              city         = COALESCE(NULLIF(EXCLUDED.city, ''), affiliations.city),
              website      = COALESCE(NULLIF(EXCLUDED.website, ''), affiliations.website),
              phone        = COALESCE(NULLIF(EXCLUDED.phone, ''), affiliations.phone),
              confidence   = GREATEST(EXCLUDED.confidence, affiliations.confidence),
              raw          = EXCLUDED.raw
          `, [
            organizerId, personId, companyName,
            aff.position || null,
            aff.country_code || null,
            aff.city || null,
            aff.website || null,
            aff.phone || null,
            sourceType, sourceRef, jobId,
            confidence,
            JSON.stringify(raw),
          ]);
        } else {
          // No company — INSERT without unique conflict (company is NULL)
          await client.query(`
            INSERT INTO affiliations (
              organizer_id, person_id, company_name, position,
              country_code, city, website, phone,
              source_type, source_ref, mining_job_id, confidence, raw
            ) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          `, [
            organizerId, personId,
            aff.position || null,
            aff.country_code || null,
            aff.city || null,
            aff.website || null,
            aff.phone || null,
            sourceType, sourceRef, jobId,
            confidence,
            JSON.stringify(raw),
          ]);
        }

        affiliationsUpserted++;
      }
    }

    await client.query('COMMIT');

    console.log(`${LOG_PREFIX} Persisted job ${jobId}: ${personsUpserted} persons, ${affiliationsUpserted} affiliations`);

    return {
      processed: true,
      persisted: true,
      persons: personsUpserted,
      affiliations: affiliationsUpserted,
      timestamp: new Date().toISOString(),
    };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`${LOG_PREFIX} ERROR persisting job ${jobId}:`, error.message);
    return {
      processed: false,
      persisted: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    };

  } finally {
    client.release();
  }
}

/**
 * Log summary for both shadow and persist modes.
 */
function logSummary(jobId, organizerId, normalizationResult, metadata) {
  const prefix = isPersistEnabled() ? LOG_PREFIX : SHADOW_PREFIX;
  const candidateCount = normalizationResult.candidates?.length || 0;

  console.log(`${prefix} ========================================`);
  console.log(`${prefix} Mining Job ID: ${jobId}`);
  console.log(`${prefix} Organizer ID: ${organizerId || 'N/A'}`);
  console.log(`${prefix} Mode: ${isPersistEnabled() ? 'PERSIST' : 'SHADOW (log only)'}`);
  console.log(`${prefix} Timestamp: ${new Date().toISOString()}`);

  if (normalizationResult.stats) {
    console.log(`${prefix} Stats:`, JSON.stringify(normalizationResult.stats));
  }

  console.log(`${prefix} Candidates: ${candidateCount}`);

  if (normalizationResult.errors?.length > 0) {
    console.log(`${prefix} Normalization errors:`, JSON.stringify(normalizationResult.errors));
  }

  if (metadata && Object.keys(metadata).length > 0) {
    console.log(`${prefix} Metadata:`, JSON.stringify(metadata));
  }

  console.log(`${prefix} ========================================`);
}

/**
 * Log individual candidates (shadow mode only).
 */
function logCandidates(jobId, candidates) {
  const candidateCount = candidates.length;

  if (VERBOSE || candidateCount <= 10) {
    for (const candidate of candidates) {
      console.log(`${SHADOW_PREFIX} Candidate:`, JSON.stringify({
        email: candidate.email,
        first_name: candidate.first_name,
        last_name: candidate.last_name,
        affiliations_count: candidate.affiliations?.length || 0,
        affiliations: candidate.affiliations?.map(a => ({
          company: a.company_name,
          position: a.position,
          country: a.country_code,
          website: a.website,
        })),
        extraction_meta: {
          miner: candidate.extraction_meta?.miner_name,
          source_url: candidate.extraction_meta?.source_url,
        },
      }));
    }
  } else {
    console.log(`${SHADOW_PREFIX} Sample (first 3):`);
    for (const candidate of candidates.slice(0, 3)) {
      console.log(`${SHADOW_PREFIX}   - ${candidate.email} (${candidate.first_name || '?'} ${candidate.last_name || '?'})`);
    }
  }
}

/**
 * Get current aggregation status.
 */
function getStatus() {
  return {
    enabled: isEnabled(),
    persist: isPersistEnabled(),
    verbose: VERBOSE,
    phase: isPersistEnabled()
      ? 'Phase 2 - Persist Mode (DB writes active)'
      : 'Phase 1 - Shadow Mode (Log only)',
  };
}

module.exports = {
  process: aggregate,
  isEnabled,
  isPersistEnabled,
  getStatus,
  LOG_PREFIX,
  SHADOW_PREFIX,
};
