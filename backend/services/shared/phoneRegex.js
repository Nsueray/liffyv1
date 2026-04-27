/**
 * Shared Phone Utilities
 *
 * Single source of truth for phone number extraction and normalization.
 * Consolidates patterns from: playwrightTableMiner, directoryMiner,
 * inlineContactMiner, labelValueMiner.
 *
 * NOTE: Existing miners keep their own regex for backward compatibility.
 * New miners and refactored code should use this module.
 */

// International phone regex — covers most formats:
// +90 (212) 555-1234, 0212 555 1234, +1-800-555-1234, etc.
const PHONE_REGEX = /(?:\+?\d{1,4}[\s\-.]?)?\(?\d{1,5}\)?[\s\-.]?\d{2,5}[\s\-.]?\d{2,5}(?:[\s\-.]?\d{1,5})?/g;

// Nigerian-specific mobile patterns
const NIGERIAN_MOBILE_REGEX = /\b0[789][01]\d{8}\b/g;

// Nigerian landline
const NIGERIAN_LANDLINE_REGEX = /\b0[1-9]\d{6,9}\b/g;

/**
 * Extract phone numbers from text.
 * Applies length validation and filters out years/junk numbers.
 * Returns deduplicated array.
 *
 * @param {string} text - Text to search
 * @returns {string[]} - Cleaned phone numbers
 */
function extractPhones(text) {
  if (!text) return [];

  const phones = new Set();

  // International format
  const intlMatches = text.match(PHONE_REGEX) || [];
  for (const match of intlMatches) {
    const cleaned = cleanPhone(match);
    if (cleaned) phones.add(cleaned);
  }

  // Nigerian mobile
  const ngMobileMatches = text.match(NIGERIAN_MOBILE_REGEX) || [];
  for (const match of ngMobileMatches) {
    const cleaned = cleanPhone(match);
    if (cleaned) phones.add(cleaned);
  }

  // Nigerian landline
  const ngLandlineMatches = text.match(NIGERIAN_LANDLINE_REGEX) || [];
  for (const match of ngLandlineMatches) {
    const cleaned = cleanPhone(match);
    if (cleaned) phones.add(cleaned);
  }

  return Array.from(phones);
}

/**
 * Clean and validate a phone number string.
 * Returns null if invalid (too short, too long, looks like a year, etc.)
 *
 * @param {string} raw - Raw phone string
 * @returns {string|null} - Cleaned phone or null
 */
function cleanPhone(raw) {
  if (!raw || typeof raw !== 'string') return null;

  // Strip common prefixes
  let cleaned = raw.replace(/^(tel:|phone:|mobile:|cell:|fax:|call:)/i, '').trim();

  // Take only first line (avoid multiline junk)
  cleaned = cleaned.split(/[\n\r]/)[0].trim();

  const digits = cleaned.replace(/\D/g, '');

  // Validate length
  if (digits.length < 7 || digits.length > 16) return null;

  // Filter out years (1900-2099)
  if (/^(19|20)\d{2}$/.test(digits)) return null;

  return cleaned;
}

/**
 * Normalize a phone number to E.164-like format.
 * Removes whitespace, dashes, parentheses. Preserves leading +.
 *
 * @param {string} phone - Phone number
 * @returns {string} - Normalized phone
 */
function normalizePhone(phone) {
  if (!phone) return '';
  // Keep + prefix, remove all non-digit/non-plus characters
  const hasPlus = phone.trim().startsWith('+');
  const digits = phone.replace(/\D/g, '');
  return hasPlus ? '+' + digits : digits;
}

module.exports = {
  PHONE_REGEX,
  NIGERIAN_MOBILE_REGEX,
  NIGERIAN_LANDLINE_REGEX,
  extractPhones,
  cleanPhone,
  normalizePhone,
};
