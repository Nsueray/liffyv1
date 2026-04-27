/**
 * Shared URL Filter Utilities
 *
 * Single source of truth for social media, map, and junk URL filtering.
 * Consolidates lists from: directoryMiner, playwrightTableMiner, contactPageMiner,
 * messeFrankfurtMiner, reedExpoMailtoMiner.
 *
 * NOTE: Existing miners keep their own lists for backward compatibility.
 * New miners and refactored code should use this module.
 */

// Social media domains — never a company website
const SOCIAL_HOSTS = [
  'facebook.com', 'fb.com', 'fb.me',
  'twitter.com', 'x.com',
  'linkedin.com',
  'instagram.com',
  'youtube.com', 'youtu.be',
  'pinterest.com',
  'tiktok.com',
  'snapchat.com',
  'reddit.com',
  'xing.com',
  'vimeo.com',
  'flickr.com',
  'wa.me', 'whatsapp.com', 'web.whatsapp.com',
  't.me', 'telegram.org',
  'line.me',
  'wechat.com', 'weixin.qq.com',
  'tumblr.com',
  'medium.com',
];

// Map service domains/paths
const MAP_HOSTS = [
  'google.com/maps', 'goo.gl/maps', 'maps.google',
  'maps.app.goo.gl', 'waze.com', 'openstreetmap.org',
  'bing.com/maps', 'maps.apple.com',
];

// Generic/infrastructure domains — not company websites
const JUNK_HOSTS = [
  'google.com', 'bing.com', 'yahoo.com',
  'apple.com', 'microsoft.com',
  'amazonaws.com', 'cloudflare.com', 'cloudfront.net',
  'w3.org', 'schema.org', 'gravatar.com',
  'gstatic.com', 'googleapis.com', 'googleusercontent.com',
  'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com',
  'jquery.com', 'bootstrapcdn.com',
  'safelinks.protection.outlook.com',
  'sentry.io', 'hotjar.com', 'segment.io', 'mixpanel.com',
  'google-analytics.com', 'googletagmanager.com',
  'doubleclick.net', 'googlesyndication.com',
  'recaptcha.net',
];

/**
 * Check if a URL points to a social media platform.
 *
 * @param {string} url - Full URL or hostname
 * @returns {boolean}
 */
function isSocialUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return SOCIAL_HOSTS.some(s => host === s || host.endsWith('.' + s));
  } catch {
    // If not a valid URL, try matching as hostname directly
    const host = url.toLowerCase().replace(/^www\./, '');
    return SOCIAL_HOSTS.some(s => host === s || host.endsWith('.' + s));
  }
}

/**
 * Check if a URL points to a map service.
 *
 * @param {string} url - Full URL
 * @returns {boolean}
 */
function isMapUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return MAP_HOSTS.some(m => lower.includes(m));
}

/**
 * Check if a URL points to a junk/infrastructure domain.
 *
 * @param {string} url - Full URL or hostname
 * @returns {boolean}
 */
function isJunkUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return JUNK_HOSTS.some(j => host === j || host.endsWith('.' + j));
  } catch {
    const host = url.toLowerCase().replace(/^www\./, '');
    return JUNK_HOSTS.some(j => host === j || host.endsWith('.' + j));
  }
}

/**
 * Check if a URL should be filtered out (social, map, or junk).
 *
 * @param {string} url - Full URL
 * @returns {boolean}
 */
function shouldFilterUrl(url) {
  return isSocialUrl(url) || isMapUrl(url) || isJunkUrl(url);
}

module.exports = {
  SOCIAL_HOSTS,
  MAP_HOSTS,
  JUNK_HOSTS,
  isSocialUrl,
  isMapUrl,
  isJunkUrl,
  shouldFilterUrl,
};
