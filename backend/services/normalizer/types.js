/**
 * LIFFY Normalization Layer - Type Definitions
 * Phase 1 - Step C: Shadow Mode Integration
 * 
 * These types define the contracts for the normalization pipeline.
 * Based on the LIFFY Product & Data Constitution.
 * 
 * RULES:
 * - Email is the SOLE identity key
 * - No email = no candidate
 * - Mining is discovery, not creation
 * - Normalizer is STATELESS
 */

/**
 * Raw output from any miner (Playwright, HTTP, AI, etc.)
 * This is the input to the normalization layer.
 * 
 * @typedef {Object} MinerRawOutput
 * @property {'success'|'partial'|'blocked'|'failed'} status - Mining operation status
 * @property {Object} raw - Raw extracted data
 * @property {string} [raw.text] - Plain text content from page
 * @property {string} [raw.html] - Raw HTML content
 * @property {Array<Object>} [raw.blocks] - Structured content blocks
 * @property {Array<string>} [raw.links] - Extracted links
 * @property {Object} meta - Mining metadata
 * @property {string} meta.miner_name - Name of the miner that produced this output
 * @property {number} [meta.duration_ms] - Time taken to mine
 * @property {number} [meta.confidence_hint] - Miner's confidence (0-1)
 * @property {string} [meta.source_url] - URL that was mined
 * @property {string} [meta.page_title] - Title of the mined page
 */

/**
 * Affiliation candidate - represents a contextual relationship
 * between a person and a company/role.
 * 
 * From Constitution: "Affiliations are additive, never overwritten"
 * 
 * @typedef {Object} AffiliationCandidate
 * @property {string|null} company_name - Company/organization name
 * @property {string|null} position - Job title/position
 * @property {string|null} country_code - ISO-2 country code
 * @property {string|null} website - Company website URL
 * @property {number} confidence - Confidence score (0-1)
 */

/**
 * Extraction metadata - tracks provenance of discovered data
 * 
 * @typedef {Object} ExtractionMeta
 * @property {string} miner_name - Which miner produced this
 * @property {string|null} source_url - URL where discovered
 * @property {string} extracted_at - ISO timestamp
 * @property {string|null} context_snippet - Surrounding text context
 * @property {number} confidence - Overall extraction confidence (0-1)
 */

/**
 * Unified Contact Candidate - the normalized output entity
 * 
 * From Constitution:
 * - "Email is the sole identity key"
 * - "A person may have multiple affiliations"
 * - "Person is organizer-scoped" (handled at aggregation, not here)
 * 
 * @typedef {Object} UnifiedContactCandidate
 * @property {string} email - Email address (MANDATORY - identity key)
 * @property {string|null} first_name - Parsed first name
 * @property {string|null} last_name - Parsed last name
 * @property {AffiliationCandidate[]} affiliations - Array of company/role contexts
 * @property {ExtractionMeta} extraction_meta - Provenance data
 */

/**
 * Result of the normalization process
 * 
 * @typedef {Object} NormalizationResult
 * @property {boolean} success - Whether normalization completed
 * @property {UnifiedContactCandidate[]} candidates - Normalized candidates
 * @property {Object} stats - Processing statistics
 * @property {number} stats.emails_found - Total emails extracted
 * @property {number} stats.candidates_produced - Valid candidates output
 * @property {number} stats.discarded - Items discarded (no email, etc.)
 * @property {string[]} [errors] - Any non-fatal errors encountered
 */

module.exports = {
  // Export empty object - types are for JSDoc documentation only
  // This file serves as the type reference for the normalizer
};
