/**
 * LIFFY Normalization Layer - Module Entry Point
 * Phase 1 - Step C: Shadow Mode Integration
 * 
 * This module provides the normalization pipeline for converting
 * raw miner output into unified contact candidates.
 * 
 * ARCHITECTURAL RULES (from Constitution):
 * 1. Mining is DISCOVERY, not creation
 * 2. Normalizer is STATELESS
 * 3. NO database access
 * 4. NO merge decisions
 * 5. NO organizer logic
 * 6. Email is the SOLE identity key
 * 
 * Usage:
 * ```javascript
 * const { normalizeMinerOutput } = require('./services/normalizer');
 * 
 * const result = normalizeMinerOutput(minerRawOutput);
 * // result.candidates contains UnifiedContactCandidate[]
 * ```
 */

const { normalizeMinerOutput } = require('./normalizeMinerOutput');
const { extractEmails, isGeneric, isValidEmailFormat } = require('./emailExtractor');
const { parseName, isGenericEmailPrefix } = require('./nameParser');
const { resolveCompany } = require('./companyResolver');
const { normalizeCountry, extractCountryFromContext } = require('./countryNormalizer');

module.exports = {
  // Main entry point
  normalizeMinerOutput,
  
  // Individual utilities (for advanced use/testing)
  extractEmails,
  parseName,
  resolveCompany,
  normalizeCountry,
  extractCountryFromContext,
  
  // Validation helpers
  isGeneric,
  isGenericEmailPrefix,
  isValidEmailFormat,
};
