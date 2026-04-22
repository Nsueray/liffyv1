// backend/services/urlAnalyzer.js
// Mineability pre-check: analyzes a URL before mining to predict success likelihood

const cheerio = require('cheerio');

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const EXHIBITOR_PATTERNS = /\/(exhibitor|company|member|profile|supplier|vendor|participant|aussteller|exposant|firma|uye|katilimci)/i;
const LOGIN_PATTERNS = /\b(login|sign[\s-]?in|log[\s-]?in|register|create[\s-]?account|auth|forgot[\s-]?password|giriş|giris|kayıt|kayit)\b/i;
const BLOCK_PATTERNS = /\b(cloudflare|captcha|challenge|access[\s-]?denied|forbidden|bot[\s-]?detection|ddos[\s-]?protection)\b/i;

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Analyze a URL for mineability before creating a mining job
 * @param {string} url
 * @returns {Promise<object>} analysis result
 */
async function analyzeUrl(url) {
  const checks = {
    reachable: false,
    page_size_kb: 0,
    email_count: 0,
    table_count: 0,
    link_count: 0,
    has_exhibitor_pattern: false,
    js_heavy: false,
    login_required: false,
    blocked: false,
  };

  const badges = [];
  const warnings = [];
  let html = '';
  let statusCode = 0;

  // 1. Fetch page
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    clearTimeout(timeout);
    statusCode = response.status;
    html = await response.text();
    checks.reachable = true;
    checks.page_size_kb = Math.round(Buffer.byteLength(html, 'utf8') / 1024);

    // Check final URL for login redirect
    const finalUrl = response.url || url;
    if (LOGIN_PATTERNS.test(finalUrl)) {
      checks.login_required = true;
    }
  } catch (err) {
    checks.reachable = false;
    warnings.push('URL is not reachable — connection failed or timed out');
    return buildResult(checks, badges, warnings);
  }

  // 2. Block detection
  if (statusCode === 403 || statusCode === 401) {
    checks.blocked = true;
    warnings.push(`Server returned ${statusCode} — access may be blocked`);
  }

  if (BLOCK_PATTERNS.test(html.slice(0, 10000))) {
    checks.blocked = true;
    warnings.push('Cloudflare/CAPTCHA protection detected — mining may fail');
  }

  // 3. Parse HTML with cheerio
  const $ = cheerio.load(html);

  // 4. Login detection
  const formHtml = $('form').toString().toLowerCase();
  if (LOGIN_PATTERNS.test(formHtml)) {
    // Verify it's a login form, not just a search form
    const hasPasswordField = $('input[type="password"]').length > 0;
    if (hasPasswordField) {
      checks.login_required = true;
      warnings.push('Login form detected — data may be behind authentication');
    }
  }

  // 5. JS-heavy detection
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const scriptCount = $('script').length;
  if (bodyText.length < 500 && checks.page_size_kb > 50) {
    checks.js_heavy = true;
    warnings.push('Page is JavaScript-heavy — may need Local Miner for SPA sites');
  } else if (scriptCount > 15 && bodyText.length < 1000) {
    checks.js_heavy = true;
    warnings.push('Page relies heavily on JavaScript rendering');
  }

  // 6. Email count
  const mailtoEmails = new Set();
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const email = href.replace('mailto:', '').split('?')[0].trim().toLowerCase();
    if (email && email.includes('@')) mailtoEmails.add(email);
  });

  const textEmails = new Set();
  const allText = html;
  let match;
  const emailRegex = new RegExp(EMAIL_REGEX.source, 'g');
  while ((match = emailRegex.exec(allText)) !== null) {
    const email = match[0].toLowerCase();
    // Filter out image/asset emails
    if (!/\.(png|jpg|gif|svg|css|js|woff)$/i.test(email) &&
        !email.includes('example.com') && !email.includes('sentry.io') &&
        !email.includes('wixpress.com') && !email.includes('w3.org')) {
      textEmails.add(email);
    }
  }

  const allEmails = new Set([...mailtoEmails, ...textEmails]);
  checks.email_count = allEmails.size;

  if (checks.email_count > 10) {
    badges.push(`${checks.email_count} email addresses found on page`);
  } else if (checks.email_count > 0) {
    badges.push(`${checks.email_count} email address${checks.email_count > 1 ? 'es' : ''} found`);
  }

  // 7. Structure detection
  checks.table_count = $('table').length;
  checks.link_count = $('a[href]').length;

  if (checks.table_count > 0) {
    badges.push(`Table structure detected (${checks.table_count} table${checks.table_count > 1 ? 's' : ''})`);
  }
  if (checks.link_count > 50) {
    badges.push(`${checks.link_count} links found — likely a directory`);
  }

  // Exhibitor pattern check
  const links = $('a[href]').map((_, el) => $(el).attr('href') || '').get();
  const exhibitorLinks = links.filter(href => EXHIBITOR_PATTERNS.test(href));
  if (exhibitorLinks.length > 0) {
    checks.has_exhibitor_pattern = true;
    badges.push(`Exhibitor/member link pattern detected (${exhibitorLinks.length} links)`);
  }

  // Small page warning
  if (checks.page_size_kb < 5 && !checks.blocked) {
    warnings.push('Very small page — may be a redirect or empty page');
  }

  return buildResult(checks, badges, warnings);
}

/**
 * Calculate score, mineability, suggested_miner, estimated_contacts from checks
 */
function buildResult(checks, badges, warnings) {
  // Scoring
  let score = 30; // base score for reachable pages

  if (!checks.reachable) score = 0;

  if (checks.email_count > 10) score += 30;
  else if (checks.email_count > 0) score += 15;

  if (checks.has_exhibitor_pattern) score += 20;
  if (checks.table_count > 0) score += 10;
  if (checks.link_count > 50) score += 10;

  if (checks.blocked) score -= 50;
  if (checks.login_required) score -= 30;
  if (checks.js_heavy) score -= 20;
  if (checks.page_size_kb < 5 && checks.reachable) score -= 15;

  // Clamp
  score = Math.max(0, Math.min(100, score));

  const mineability = score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low';

  // Suggested miner
  let suggested_miner = 'playwrightMiner';
  if (checks.email_count > 5 && checks.table_count > 0) {
    suggested_miner = 'tableMiner / inlineContactMiner';
  } else if (checks.has_exhibitor_pattern) {
    suggested_miner = 'directoryMiner';
  } else if (checks.js_heavy) {
    suggested_miner = 'Local Miner (SPA support needed)';
  } else if (checks.email_count > 5) {
    suggested_miner = 'inlineContactMiner';
  }

  // Estimated contacts
  let estimated_contacts = 0;
  if (checks.email_count > 0) {
    estimated_contacts = checks.email_count;
  } else if (checks.has_exhibitor_pattern) {
    estimated_contacts = Math.round(checks.link_count / 5);
  } else if (checks.link_count > 50) {
    estimated_contacts = Math.round(checks.link_count / 10);
  }

  return {
    mineability,
    score,
    checks,
    badges,
    warnings,
    suggested_miner,
    estimated_contacts,
  };
}

module.exports = { analyzeUrl };
