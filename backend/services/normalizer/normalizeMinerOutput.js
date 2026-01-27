/**
 * LIFFY Normalization Layer - Main Orchestrator
 * Phase 1 - Step C: Shadow Mode Integration
 * 
 * Orchestrates the normalization pipeline:
 * MinerRawOutput → UnifiedContactCandidate[]
 * 
 * RULES (from Constitution):
 * - Mining is discovery, not creation
 * - Email is MANDATORY - no email = no candidate
 * - Normalizer is STATELESS
 * - NO database access
 * - NO merge decisions
 * - NO organizer logic
 * - NO deduplicate across runs
 * - NO confidence calculation (confidence comes from miner only)
 */

const { extractEmails } = require('./emailExtractor');
const { parseName } = require('./nameParser');
const { resolveCompany } = require('./companyResolver');
const { extractCountryFromContext } = require('./countryNormalizer');

/**
 * Extract position/job title from context
 * 
 * @param {string} context - Text context
 * @returns {string|null}
 */
function extractPosition(context) {
  if (!context || typeof context !== 'string') return null;
  
  // Common job title patterns
  const patterns = [
    // "Title at Company" or "Title | Company"
    /\b(CEO|CFO|CTO|COO|CMO|VP|Director|Manager|Engineer|Developer|Designer|Analyst|Consultant|Sales|Marketing|HR|Admin|Owner|Founder|President|Executive|Specialist|Coordinator|Lead|Head|Chief)\b[^,\n]*/i,
    // After position labels
    /(?:position|title|role):\s*([^,\n]+)/i,
    // Turkish titles
    /\b(Müdür|Yönetici|Mühendis|Uzman|Direktör|Koordinatör|Temsilci|Satış|Pazarlama)\b[^,\n]*/i,
  ];
  
  for (const pattern of patterns) {
    const match = context.match(pattern);
    if (match) {
      const position = match[0].trim();
      // Validate length
      if (position.length >= 2 && position.length <= 100) {
        return position;
      }
    }
  }
  
  return null;
}

/**
 * Build affiliation from context and metadata
 * 
 * @param {string} email - Email address
 * @param {string|null} context - Text context near email
 * @param {Object|null} meta - Mining metadata
 * @returns {import('./types').AffiliationCandidate}
 */
function buildAffiliation(email, context, meta) {
  // Resolve company
  const { company_name, website } = resolveCompany(email, context, meta);
  
  // Extract position
  const position = extractPosition(context);
  
  // Normalize country
  let country_code = null;
  if (context) {
    country_code = extractCountryFromContext(context);
  }
  
  const affiliation = {
    company_name: company_name || null,
    position: position || null,
    country_code: country_code || null,
    website: website || null,
    confidence: null,  // Normalizer MUST NOT calculate confidence
  };
  
  return affiliation;
}

/**
 * Build extraction metadata
 * 
 * @param {Object} meta - Mining metadata
 * @param {string|null} context - Text context
 * @returns {import('./types').ExtractionMeta}
 */
function buildExtractionMeta(meta, context) {
  return {
    miner_name: meta?.miner_name || 'unknown',
    source_url: meta?.source_url || null,
    extracted_at: new Date().toISOString(),
    context_snippet: context ? context.substring(0, 200) : null,
    confidence: meta?.confidence_hint || null,  // Pass through from miner only
  };
}

/**
 * Main normalization function
 * 
 * Transforms MinerRawOutput into UnifiedContactCandidate[]
 * 
 * IMPORTANT: This function is STATELESS
 * - NO database access
 * - NO merge decisions
 * - NO organizer logic
 * - NO deduplication across runs
 * - NO confidence calculation
 * 
 * @param {import('./types').MinerRawOutput} minerOutput - Raw miner output
 * @returns {import('./types').NormalizationResult}
 */
function normalizeMinerOutput(minerOutput) {
  const result = {
    success: false,
    candidates: [],
    stats: {
      emails_found: 0,
      candidates_produced: 0,
      discarded: 0,
    },
    errors: [],
  };
  
  // Validate input
  if (!minerOutput) {
    result.errors.push('No miner output provided');
    return result;
  }
  
  if (minerOutput.status === 'failed') {
    result.errors.push('Miner reported failure status');
    return result;
  }
  
  if (!minerOutput.raw) {
    result.errors.push('No raw data in miner output');
    return result;
  }
  
  try {
    // Step 1: Extract emails
    const { emails, contexts } = extractEmails(minerOutput);
    result.stats.emails_found = emails.length;
    
    if (emails.length === 0) {
      result.errors.push('No valid emails found in miner output');
      result.success = true; // Not an error, just no results
      return result;
    }
    
    // Step 2: Process each email
    const meta = minerOutput.meta || {};
    
    for (const email of emails) {
      try {
        // Get context for this email
        const context = contexts.get(email) || null;
        
        // Parse name
        const { first_name, last_name } = parseName(email, context);
        
        // Build affiliation
        const affiliation = buildAffiliation(email, context, meta);
        
        // Build extraction metadata
        const extraction_meta = buildExtractionMeta(meta, context);
        
        // Create candidate
        /** @type {import('./types').UnifiedContactCandidate} */
        const candidate = {
          email: email,
          first_name: first_name,
          last_name: last_name,
          affiliations: [],
          extraction_meta: extraction_meta,
        };
        
        // Add affiliation if it has any data
        if (affiliation.company_name || affiliation.position || 
            affiliation.country_code || affiliation.website) {
          candidate.affiliations.push(affiliation);
        }
        
        result.candidates.push(candidate);
        result.stats.candidates_produced++;
        
      } catch (emailError) {
        result.errors.push(`Error processing email ${email}: ${emailError.message}`);
        result.stats.discarded++;
      }
    }
    
    result.success = true;
    
  } catch (error) {
    result.success = false;
    result.errors.push(`Normalization error: ${error.message}`);
  }
  
  return result;
}

module.exports = {
  normalizeMinerOutput,
  // Export helpers for testing
  buildAffiliation,
  extractPosition,
};
