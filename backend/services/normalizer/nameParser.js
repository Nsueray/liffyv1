/**
 * LIFFY Normalization Layer - Name Parser
 * Phase 1 - Step C: Shadow Mode Integration
 * 
 * Parses names from context near emails.
 * 
 * RULES (from Constitution):
 * - Max two tokens for name
 * - Remove titles (Mr, Mrs, Dr, etc.)
 * - Generic addresses yield no name
 * - No guessing - if unclear, return null
 */

/**
 * Titles to remove from names
 */
const TITLES = [
  'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'professor',
  'sir', 'madam', 'mx', 'rev', 'reverend', 'fr', 'father',
  'br', 'brother', 'sr', 'sister', 'hon', 'honorable',
  'judge', 'justice', 'eng', 'engr', 'arch', 'atty', 'attorney',
  'cpa', 'esq', 'esquire', 'phd', 'md', 'dds', 'dvm', 'od',
  'herr', 'frau', 'señor', 'señora', 'monsieur', 'madame',
  'bay', 'bayan', 'sayın', // Turkish
];

/**
 * Suffixes to remove
 */
const SUFFIXES = [
  'jr', 'sr', 'i', 'ii', 'iii', 'iv', 'v',
  'phd', 'md', 'dds', 'dvm', 'esq', 'cpa',
];

/**
 * Generic email prefixes that indicate non-person emails
 */
const GENERIC_PREFIXES = [
  'info', 'contact', 'support', 'hello', 'help', 'sales',
  'admin', 'webmaster', 'noreply', 'no-reply', 'mail', 'email',
  'enquiry', 'enquiries', 'office', 'general', 'team', 'hr',
  'marketing', 'billing', 'accounts', 'jobs', 'careers',
  'press', 'media', 'news', 'legal', 'compliance',
];

/**
 * Check if email prefix is generic (not a person)
 * @param {string} email 
 * @returns {boolean}
 */
function isGenericEmailPrefix(email) {
  if (!email || typeof email !== 'string') return true;
  const prefix = email.split('@')[0].toLowerCase();
  return GENERIC_PREFIXES.includes(prefix);
}

/**
 * Remove title from name
 * @param {string} name 
 * @returns {string}
 */
function removeTitle(name) {
  if (!name) return name;
  
  const words = name.split(/\s+/);
  if (words.length === 0) return name;
  
  // Check if first word is a title
  const firstWord = words[0].toLowerCase().replace(/[.,]/g, '');
  if (TITLES.includes(firstWord)) {
    words.shift();
  }
  
  return words.join(' ');
}

/**
 * Remove suffix from name
 * @param {string} name 
 * @returns {string}
 */
function removeSuffix(name) {
  if (!name) return name;
  
  const words = name.split(/\s+/);
  if (words.length === 0) return name;
  
  // Check if last word is a suffix
  const lastWord = words[words.length - 1].toLowerCase().replace(/[.,]/g, '');
  if (SUFFIXES.includes(lastWord)) {
    words.pop();
  }
  
  return words.join(' ');
}

/**
 * Clean and normalize a name string
 * @param {string} name 
 * @returns {string}
 */
function cleanName(name) {
  if (!name || typeof name !== 'string') return '';
  
  return name
    // Remove special characters except spaces and hyphens
    .replace(/[^a-zA-ZÀ-ÿ\s-]/g, '')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Validate a name token
 * @param {string} token 
 * @returns {boolean}
 */
function isValidNameToken(token) {
  if (!token || typeof token !== 'string') return false;
  
  const cleaned = token.trim();
  
  // Must be 2-50 chars
  if (cleaned.length < 2 || cleaned.length > 50) return false;
  
  // Must contain at least one letter
  if (!/[a-zA-ZÀ-ÿ]/.test(cleaned)) return false;
  
  // Should not be all numbers
  if (/^\d+$/.test(cleaned)) return false;
  
  return true;
}

/**
 * Try to extract name from email prefix
 * e.g., john.smith@company.com -> John Smith
 * 
 * @param {string} email 
 * @returns {{first_name: string|null, last_name: string|null}}
 */
function extractNameFromEmail(email) {
  if (!email || typeof email !== 'string') {
    return { first_name: null, last_name: null };
  }
  
  // Check if generic prefix
  if (isGenericEmailPrefix(email)) {
    return { first_name: null, last_name: null };
  }
  
  const prefix = email.split('@')[0].toLowerCase();
  
  // Try common patterns
  // Pattern: firstname.lastname or firstname_lastname
  const dotMatch = prefix.match(/^([a-z]+)[._]([a-z]+)$/);
  if (dotMatch) {
    const firstName = dotMatch[1].charAt(0).toUpperCase() + dotMatch[1].slice(1);
    const lastName = dotMatch[2].charAt(0).toUpperCase() + dotMatch[2].slice(1);
    
    if (isValidNameToken(firstName) && isValidNameToken(lastName)) {
      return { first_name: firstName, last_name: lastName };
    }
  }
  
  // Pattern: firstnamelastname (too ambiguous, skip)
  // Pattern: flastname or firstnamel (skip - too unreliable)
  
  return { first_name: null, last_name: null };
}

/**
 * Try to extract name from context text
 * @param {string} context 
 * @returns {{first_name: string|null, last_name: string|null}}
 */
function extractNameFromContext(context) {
  if (!context || typeof context !== 'string') {
    return { first_name: null, last_name: null };
  }
  
  // Look for name patterns before common separators
  // Patterns like "John Smith | " or "John Smith - " or "Contact: John Smith"
  const patterns = [
    // "Name - title" or "Name | Company"
    /([A-ZÀ-ÿ][a-zA-ZÀ-ÿ]+)\s+([A-ZÀ-ÿ][a-zA-ZÀ-ÿ]+)\s*[-|,]/,
    // "Name" followed by email
    /([A-ZÀ-ÿ][a-zA-ZÀ-ÿ]+)\s+([A-ZÀ-ÿ][a-zA-ZÀ-ÿ]+)\s*[<(]/,
    // After "Contact:" or "Name:"
    /(?:contact|name|person|rep|representative):\s*([A-ZÀ-ÿ][a-zA-ZÀ-ÿ]+)\s+([A-ZÀ-ÿ][a-zA-ZÀ-ÿ]+)/i,
    // After "by" or "from"
    /(?:by|from)\s+([A-ZÀ-ÿ][a-zA-ZÀ-ÿ]+)\s+([A-ZÀ-ÿ][a-zA-ZÀ-ÿ]+)/i,
  ];
  
  for (const pattern of patterns) {
    const match = context.match(pattern);
    if (match) {
      let firstName = match[1].trim();
      let lastName = match[2].trim();
      
      // Remove titles
      firstName = removeTitle(firstName);
      lastName = removeSuffix(lastName);
      
      if (isValidNameToken(firstName) && isValidNameToken(lastName)) {
        return { first_name: firstName, last_name: lastName };
      }
    }
  }
  
  return { first_name: null, last_name: null };
}

/**
 * Main name parsing function
 * 
 * @param {string} email - The email address (used to check if generic)
 * @param {string|null} context - Text context near the email
 * @returns {{first_name: string|null, last_name: string|null}}
 */
function parseName(email, context) {
  // If generic email, no name
  if (isGenericEmailPrefix(email)) {
    return { first_name: null, last_name: null };
  }
  
  // Try context first (more reliable)
  if (context) {
    const contextName = extractNameFromContext(context);
    if (contextName.first_name && contextName.last_name) {
      return contextName;
    }
  }
  
  // Fall back to email prefix
  const emailName = extractNameFromEmail(email);
  if (emailName.first_name || emailName.last_name) {
    return emailName;
  }
  
  return { first_name: null, last_name: null };
}

module.exports = {
  parseName,
  isGenericEmailPrefix,
  extractNameFromEmail,
  extractNameFromContext,
};
