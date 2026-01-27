/**
 * LIFFY Normalization Layer - Email Extractor
 * Phase 1 - Step C: Shadow Mode Integration
 * 
 * Extracts unique, valid emails from MinerRawOutput.
 * 
 * RULES (from Constitution):
 * - Email is MANDATORY - no email = no candidate
 * - Email is the sole identity key
 * - Normalizer must be STATELESS
 */

/**
 * Email regex pattern - RFC 5322 simplified
 * Captures most valid email addresses while avoiding false positives
 */
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Generic/invalid email patterns to filter out
 * These are not real person emails
 */
const GENERIC_EMAIL_PATTERNS = [
  /^(info|contact|support|hello|help|sales|admin|webmaster|noreply|no-reply|mail|email|enquiry|enquiries|office|general)@/i,
  /^(postmaster|hostmaster|abuse|spam|mailer-daemon)@/i,
  /example\.(com|org|net)$/i,
  /test@/i,
  /@localhost$/i,
  /@127\.0\.0\.1$/i,
];

/**
 * Invalid TLDs or patterns
 */
const INVALID_PATTERNS = [
  /\.(jpg|jpeg|png|gif|svg|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar)$/i,
  /@[^.]+$/,  // No TLD
  /\.{2,}/,   // Multiple consecutive dots
  /^[.-]/,   // Starts with dot or dash
  /[.-]$/,   // Ends with dot or dash
];

/**
 * Check if email is generic (not a person)
 * @param {string} email 
 * @returns {boolean}
 */
function isGenericEmail(email) {
  const lowerEmail = email.toLowerCase();
  return GENERIC_EMAIL_PATTERNS.some(pattern => pattern.test(lowerEmail));
}

/**
 * Check if email has invalid pattern
 * @param {string} email 
 * @returns {boolean}
 */
function hasInvalidPattern(email) {
  return INVALID_PATTERNS.some(pattern => pattern.test(email));
}

/**
 * Basic email format validation
 * @param {string} email 
 * @returns {boolean}
 */
function isValidEmailFormat(email) {
  if (!email || typeof email !== 'string') return false;
  if (email.length < 5 || email.length > 254) return false;
  
  const parts = email.split('@');
  if (parts.length !== 2) return false;
  
  const [local, domain] = parts;
  if (!local || !domain) return false;
  if (local.length > 64) return false;
  if (domain.length > 253) return false;
  
  // Domain must have at least one dot
  if (!domain.includes('.')) return false;
  
  // TLD must be at least 2 characters
  const tld = domain.split('.').pop();
  if (!tld || tld.length < 2) return false;
  
  return true;
}

/**
 * Extract emails from text content
 * @param {string} text 
 * @returns {string[]}
 */
function extractFromText(text) {
  if (!text || typeof text !== 'string') return [];
  
  const matches = text.match(EMAIL_REGEX) || [];
  return matches.map(email => email.toLowerCase().trim());
}

/**
 * Extract emails from blocks array
 * Blocks may contain structured data with email fields
 * @param {Array<Object>} blocks 
 * @returns {string[]}
 */
function extractFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  
  const emails = [];
  
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    
    // Direct email field
    if (block.email && typeof block.email === 'string') {
      emails.push(block.email.toLowerCase().trim());
    }
    
    // Emails array
    if (Array.isArray(block.emails)) {
      for (const email of block.emails) {
        if (typeof email === 'string') {
          emails.push(email.toLowerCase().trim());
        }
      }
    }
    
    // Text content within block
    if (block.text && typeof block.text === 'string') {
      emails.push(...extractFromText(block.text));
    }
    
    // Content field
    if (block.content && typeof block.content === 'string') {
      emails.push(...extractFromText(block.content));
    }
    
    // Nested data
    if (block.data && typeof block.data === 'object') {
      if (block.data.email) {
        emails.push(block.data.email.toLowerCase().trim());
      }
      if (block.data.contact_email) {
        emails.push(block.data.contact_email.toLowerCase().trim());
      }
    }
  }
  
  return emails;
}

/**
 * Main extraction function
 * Extracts unique, valid emails from MinerRawOutput
 * 
 * @param {import('./types').MinerRawOutput} minerOutput 
 * @returns {{emails: string[], contexts: Map<string, string>}}
 *   - emails: Array of unique valid emails
 *   - contexts: Map of email -> surrounding text context
 */
function extractEmails(minerOutput) {
  const allEmails = [];
  const emailContexts = new Map();
  
  if (!minerOutput || !minerOutput.raw) {
    return { emails: [], contexts: emailContexts };
  }
  
  const { raw } = minerOutput;
  
  // Extract from text
  if (raw.text) {
    const textEmails = extractFromText(raw.text);
    for (const email of textEmails) {
      allEmails.push(email);
      // Capture context (50 chars before and after)
      if (!emailContexts.has(email)) {
        const idx = raw.text.toLowerCase().indexOf(email);
        if (idx !== -1) {
          const start = Math.max(0, idx - 50);
          const end = Math.min(raw.text.length, idx + email.length + 50);
          emailContexts.set(email, raw.text.substring(start, end).trim());
        }
      }
    }
  }
  
  // Extract from HTML (if text wasn't provided)
  if (raw.html && !raw.text) {
    const htmlEmails = extractFromText(raw.html);
    allEmails.push(...htmlEmails);
  }
  
  // Extract from blocks
  if (raw.blocks) {
    const blockEmails = extractFromBlocks(raw.blocks);
    allEmails.push(...blockEmails);
  }
  
  // Deduplicate and validate
  const seen = new Set();
  const validEmails = [];
  
  for (const email of allEmails) {
    // Skip if already seen
    if (seen.has(email)) continue;
    seen.add(email);
    
    // Validate format
    if (!isValidEmailFormat(email)) continue;
    
    // Skip invalid patterns
    if (hasInvalidPattern(email)) continue;
    
    // Skip generic emails
    if (isGenericEmail(email)) continue;
    
    validEmails.push(email);
  }
  
  return { emails: validEmails, contexts: emailContexts };
}

/**
 * Check if an email is a generic/non-person email
 * Exported for use in other modules
 * 
 * @param {string} email 
 * @returns {boolean}
 */
function isGeneric(email) {
  return isGenericEmail(email);
}

module.exports = {
  extractEmails,
  isGeneric,
  isValidEmailFormat,
};
