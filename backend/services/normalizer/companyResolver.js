/**
 * LIFFY Normalization Layer - Company Resolver
 * Phase 1 - Step C: Shadow Mode Integration
 * 
 * Resolves company name using priority order:
 * 1. Explicit context near email
 * 2. Page title (if available in raw)
 * 3. Domain fallback
 * 
 * RULES (from Constitution):
 * - No guessing - if unclear, return null
 * - Affiliations are additive, never overwritten
 * - Company is part of Affiliation, not Person
 */

/**
 * Generic terms that are not company names
 */
const GENERIC_TERMS = [
  'home', 'contact', 'about', 'services', 'products', 'team',
  'blog', 'news', 'events', 'careers', 'jobs', 'faq', 'help',
  'support', 'login', 'register', 'privacy', 'terms', 'legal',
  'exhibitors', 'exhibitor', 'list', 'directory', 'catalog',
  'welcome', 'loading', 'untitled', 'page', 'site', 'website',
];

/**
 * Domain suffixes to strip when creating fallback company name
 */
const DOMAIN_SUFFIXES = [
  '.com', '.org', '.net', '.io', '.co', '.app', '.dev',
  '.biz', '.info', '.edu', '.gov', '.mil',
  '.com.tr', '.org.tr', '.net.tr', '.com.uk', '.co.uk',
  '.com.au', '.co.nz', '.com.br', '.de', '.fr', '.es', '.it',
];

/**
 * Clean and validate company name
 * @param {string} name 
 * @returns {string|null}
 */
function cleanCompanyName(name) {
  if (!name || typeof name !== 'string') return null;
  
  let cleaned = name
    // Remove excessive whitespace
    .replace(/\s+/g, ' ')
    .trim();
  
  // Must be at least 2 characters
  if (cleaned.length < 2) return null;
  
  // Must not be too long (likely garbage)
  if (cleaned.length > 200) return null;
  
  // Must contain at least one letter
  if (!/[a-zA-ZÀ-ÿ]/.test(cleaned)) return null;
  
  // Check if it's a generic term
  if (GENERIC_TERMS.includes(cleaned.toLowerCase())) return null;
  
  return cleaned;
}

/**
 * Extract company from context text near email
 * 
 * @param {string} context - Text surrounding the email
 * @returns {string|null}
 */
function extractFromContext(context) {
  if (!context || typeof context !== 'string') return null;
  
  // Patterns to find company names
  const patterns = [
    // "Company Name | Contact"
    /^([^|]+)\s*\|/,
    // "Company Name - Contact"
    /^([^-]+)\s*-/,
    // "at Company Name" or "@ Company Name"
    /(?:at|@)\s+([A-ZÀ-ÿ][^,.\n]+)/i,
    // "from Company Name"
    /from\s+([A-ZÀ-ÿ][^,.\n]+)/i,
    // "Company Name\nContact"
    /^([^\n]+)\n/,
  ];
  
  for (const pattern of patterns) {
    const match = context.match(pattern);
    if (match) {
      const candidate = cleanCompanyName(match[1]);
      if (candidate) {
        return candidate;
      }
    }
  }
  
  return null;
}

/**
 * Extract company from page title
 * 
 * @param {string} pageTitle 
 * @returns {string|null}
 */
function extractFromPageTitle(pageTitle) {
  if (!pageTitle || typeof pageTitle !== 'string') return null;
  
  let title = pageTitle.trim();
  
  // Remove common page title suffixes
  const suffixPatterns = [
    /\s*[-|–—]\s*exhibitor(s)?.*$/i,
    /\s*[-|–—]\s*contact.*$/i,
    /\s*[-|–—]\s*home.*$/i,
    /\s*[-|–—]\s*about.*$/i,
    /\s*[-|–—]\s*official.*$/i,
    /\s*[-|–—]\s*welcome.*$/i,
  ];
  
  for (const pattern of suffixPatterns) {
    title = title.replace(pattern, '');
  }
  
  // Take first part before common separators
  const separators = ['|', '-', '–', '—', ':', '•'];
  for (const sep of separators) {
    const idx = title.indexOf(sep);
    if (idx > 0) {
      title = title.substring(0, idx);
    }
  }
  
  return cleanCompanyName(title);
}

/**
 * Extract company name from email domain as fallback
 * 
 * @param {string} email 
 * @returns {string|null}
 */
function extractFromDomain(email) {
  if (!email || typeof email !== 'string') return null;
  
  const parts = email.split('@');
  if (parts.length !== 2) return null;
  
  let domain = parts[1].toLowerCase();
  
  // Skip generic email providers
  const genericProviders = [
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
    'icloud.com', 'aol.com', 'mail.com', 'protonmail.com',
    'yandex.com', 'zoho.com', 'live.com', 'msn.com',
  ];
  
  if (genericProviders.includes(domain)) {
    return null;
  }
  
  // Remove TLD
  for (const suffix of DOMAIN_SUFFIXES) {
    if (domain.endsWith(suffix)) {
      domain = domain.slice(0, -suffix.length);
      break;
    }
  }
  
  // Remove www
  if (domain.startsWith('www.')) {
    domain = domain.slice(4);
  }
  
  // Capitalize first letter of each word
  const companyName = domain
    .split(/[-_.]/)
    .filter(part => part.length > 0)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  
  return cleanCompanyName(companyName);
}

/**
 * Extract website URL from context or domain
 * 
 * @param {string} context - Text context
 * @param {string} email - Email address
 * @returns {string|null}
 */
function extractWebsite(context, email) {
  // Try to find URL in context
  if (context) {
    const urlPattern = /https?:\/\/[^\s<>"]+/gi;
    const matches = context.match(urlPattern);
    if (matches && matches.length > 0) {
      // Return first non-social-media URL
      for (const url of matches) {
        const lowerUrl = url.toLowerCase();
        if (!lowerUrl.includes('linkedin.') &&
            !lowerUrl.includes('facebook.') &&
            !lowerUrl.includes('twitter.') &&
            !lowerUrl.includes('instagram.')) {
          return url;
        }
      }
    }
  }
  
  // Fallback to domain from email
  if (email) {
    const parts = email.split('@');
    if (parts.length === 2) {
      const domain = parts[1].toLowerCase();
      // Skip generic providers
      const genericProviders = [
        'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
        'icloud.com', 'aol.com', 'mail.com', 'protonmail.com',
      ];
      if (!genericProviders.includes(domain)) {
        return `https://${domain}`;
      }
    }
  }
  
  return null;
}

/**
 * Main company resolution function
 * Follows priority order: context > page title > domain fallback
 * 
 * @param {string} email - Email address
 * @param {string|null} context - Text context near email
 * @param {Object|null} meta - Mining metadata (may contain page_title)
 * @returns {{company_name: string|null, website: string|null}}
 */
function resolveCompany(email, context, meta) {
  let companyName = null;
  let website = null;
  
  // Priority 1: Explicit context near email
  if (context) {
    companyName = extractFromContext(context);
  }
  
  // Priority 2: Page title
  if (!companyName && meta && meta.page_title) {
    companyName = extractFromPageTitle(meta.page_title);
  }
  
  // Priority 3: Domain fallback
  if (!companyName) {
    companyName = extractFromDomain(email);
  }
  
  // Extract website
  website = extractWebsite(context, email);
  
  return { company_name: companyName, website };
}

module.exports = {
  resolveCompany,
  extractFromContext,
  extractFromPageTitle,
  extractFromDomain,
  extractWebsite,
};
