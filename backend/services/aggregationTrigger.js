/**
 * LIFFY Aggregation Trigger - Shadow Mode
 * Phase 1 - Step C: Shadow Mode Integration
 * 
 * This is a LOG-ONLY implementation for shadow mode.
 * It receives normalized candidates and logs them for observation.
 * 
 * CRITICAL RULES:
 * - MUST NOT write to database
 * - MUST NOT merge data
 * - MUST NOT affect any existing behavior
 * - LOG ONLY with [SHADOW_MODE_DATA] prefix
 */

/**
 * Shadow mode prefix for log identification
 */
const LOG_PREFIX = '[SHADOW_MODE_DATA]';

/**
 * Environment flag for verbose logging
 */
const VERBOSE = process.env && process.env.SHADOW_MODE_VERBOSE === 'true';

/**
 * Process normalized candidates (SHADOW MODE - LOG ONLY)
 * 
 * This function:
 * - Logs candidate data for observation
 * - Does NOT persist anything
 * - Does NOT merge anything
 * - Does NOT affect any existing data
 * 
 * @param {Object} options
 * @param {number} options.jobId - Mining job ID (for context)
 * @param {Object} options.normalizationResult - Result from normalizer
 * @param {Object} [options.metadata] - Additional context
 */
function process({ jobId, normalizationResult, metadata = {} }) {
  try {
    // Log header
    console.log(`${LOG_PREFIX} ========================================`);
    console.log(`${LOG_PREFIX} Mining Job ID: ${jobId}`);
    console.log(`${LOG_PREFIX} Timestamp: ${new Date().toISOString()}`);
    
    // Log stats
    if (normalizationResult.stats) {
      console.log(`${LOG_PREFIX} Stats:`, JSON.stringify(normalizationResult.stats));
    }
    
    // Log candidate count
    const candidateCount = normalizationResult.candidates?.length || 0;
    console.log(`${LOG_PREFIX} Candidates produced: ${candidateCount}`);
    
    // Log each candidate (in verbose mode or if few candidates)
    if (VERBOSE || candidateCount <= 10) {
      for (const candidate of normalizationResult.candidates || []) {
        console.log(`${LOG_PREFIX} Candidate:`, JSON.stringify({
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
        }, null, 2));
      }
    } else {
      // Summary only for large batches
      console.log(`${LOG_PREFIX} Sample (first 3 candidates):`);
      for (const candidate of normalizationResult.candidates.slice(0, 3)) {
        console.log(`${LOG_PREFIX}   - ${candidate.email} (${candidate.first_name || '?'} ${candidate.last_name || '?'})`);
      }
    }
    
    // Log any errors from normalization
    if (normalizationResult.errors?.length > 0) {
      console.log(`${LOG_PREFIX} Normalization errors:`, JSON.stringify(normalizationResult.errors));
    }
    
    // Log metadata if provided
    if (metadata && Object.keys(metadata).length > 0) {
      console.log(`${LOG_PREFIX} Metadata:`, JSON.stringify(metadata));
    }
    
    console.log(`${LOG_PREFIX} ========================================`);
    
    // Return success indicator (no persistence, just acknowledgment)
    return {
      processed: true,
      candidateCount: candidateCount,
      timestamp: new Date().toISOString(),
    };
    
  } catch (error) {
    console.error(`${LOG_PREFIX} ERROR in aggregation trigger:`, error.message);
    return {
      processed: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Check if shadow mode is enabled
 * 
 * @returns {boolean}
 */
function isEnabled() {
  return process.env.DISABLE_SHADOW_MODE !== 'true';
}

/**
 * Get shadow mode status
 * 
 * @returns {Object}
 */
function getStatus() {
  return {
    enabled: isEnabled(),
    verbose: VERBOSE,
    phase: 'Phase 1 - Shadow Mode (Log Only)',
    description: 'Normalization layer active, no data persistence',
  };
}

module.exports = {
  process,
  isEnabled,
  getStatus,
  LOG_PREFIX,
};
