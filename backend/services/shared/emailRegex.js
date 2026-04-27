/**
 * Shared Email Utilities
 *
 * Single source of truth for email extraction, validation, and classification.
 * Consolidates patterns from: contactPageMiner, inlineContactMiner, directoryMiner,
 * mcexpocomfortMiner, reedExpoMiner, reedExpoMailtoMiner, normalizer/nameParser.
 *
 * NOTE: Existing miners keep their own regex for backward compatibility.
 * New miners and refactored code should use this module.
 */

// Comprehensive email regex — case-insensitive, global
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// Generic email prefixes — role-based addresses, not personal
const GENERIC_PREFIXES = [
  'info', 'contact', 'admin', 'support', 'hello', 'help', 'sales',
  'webmaster', 'noreply', 'no-reply', 'mail', 'email',
  'enquiry', 'enquiries', 'office', 'general', 'team', 'hr',
  'marketing', 'billing', 'accounts', 'jobs', 'careers',
  'press', 'media', 'news', 'legal', 'compliance',
  'reception', 'secretary', 'postmaster',
];

// Junk/system email prefixes — should be excluded entirely
const JUNK_PREFIXES = [
  'mailer-daemon', 'postmaster', 'no-reply', 'noreply', 'donotreply',
  'bounce', 'unsubscribe', 'abuse', 'root', 'webmaster',
  'daemon', 'devnull', 'null',
];

// Junk email domains — platform/CMS/tracking domains, never real contacts
const JUNK_EMAIL_DOMAINS = [
  'example.com', 'example.org', 'example.net', 'test.com', 'test.org',
  'sentry.io', 'sentry-next.wixpress.com',
  'wix.com', 'wordpress.com', 'squarespace.com', 'weebly.com',
  'shopify.com', 'webflow.io',
  'googleapis.com', 'googleusercontent.com', 'gstatic.com', 'google.com',
  'w3.org', 'schema.org', 'gravatar.com',
  'facebook.com', 'twitter.com', 'instagram.com', 'youtube.com', 'linkedin.com',
  'tiktok.com', 'pinterest.com',
  'reedexpo.com', 'rxglobal.com',
  'mcexpocomfort.it',
  'cloudflare.com', 'cloudflareinsights.com',
  'hotjar.com', 'segment.io', 'mixpanel.com',
];

/**
 * Extract all valid email addresses from text.
 * Returns deduplicated, lowercased array.
 *
 * @param {string} text - Text to search
 * @returns {string[]} - Unique email addresses
 */
function extractEmails(text) {
  if (!text) return [];
  const matches = text.match(EMAIL_REGEX) || [];
  const seen = new Set();
  const result = [];
  for (const m of matches) {
    const email = m.toLowerCase().trim();
    if (!seen.has(email)) {
      seen.add(email);
      result.push(email);
    }
  }
  return result;
}

/**
 * Check if an email is a generic/role-based address (info@, contact@, etc.)
 * These are valid but less valuable than personal emails.
 *
 * @param {string} email
 * @returns {boolean}
 */
function isGenericEmail(email) {
  if (!email) return false;
  const prefix = email.toLowerCase().split('@')[0];
  return GENERIC_PREFIXES.includes(prefix);
}

/**
 * Check if an email is junk/system and should be excluded entirely.
 * Checks both prefix (mailer-daemon@) and domain (@example.com).
 *
 * @param {string} email
 * @returns {boolean}
 */
function isJunkEmail(email) {
  if (!email) return true;
  const lower = email.toLowerCase();
  const prefix = lower.split('@')[0];

  // Junk prefix check
  if (JUNK_PREFIXES.includes(prefix)) return true;

  // Junk domain check
  if (JUNK_EMAIL_DOMAINS.some(d => lower.endsWith('@' + d) || lower.endsWith('.' + d))) return true;

  return false;
}

module.exports = {
  EMAIL_REGEX,
  GENERIC_PREFIXES,
  JUNK_PREFIXES,
  JUNK_EMAIL_DOMAINS,
  extractEmails,
  isGenericEmail,
  isJunkEmail,
};
