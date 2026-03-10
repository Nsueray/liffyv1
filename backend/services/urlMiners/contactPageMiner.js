/**
 * LIFFY Contact Page Miner v1.0
 *
 * Extracts email addresses from company websites by:
 * 1. Scanning the homepage for mailto: links and email patterns
 * 2. Trying common contact/about page paths
 * 3. Stopping at the first email found (no unnecessary crawl)
 *
 * Returns raw data — normalization handled by flowOrchestrator.
 *
 * Usage (module only — browser lifecycle managed by flowOrchestrator wrapper):
 *   const { runContactPageMiner } = require("./contactPageMiner");
 *   const results = await runContactPageMiner(page, websiteUrl, config);
 */

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Generic email prefixes — still returned but flagged
const GENERIC_PREFIXES = [
  'noreply', 'no-reply', 'info', 'contact', 'admin', 'support',
  'hello', 'office', 'mail', 'enquiry', 'enquiries', 'sales',
  'marketing', 'hr', 'billing', 'webmaster', 'postmaster',
  'general', 'reception', 'secretary'
];

// Junk emails to completely exclude
const JUNK_EMAIL_DOMAINS = [
  'example.com', 'example.org', 'test.com', 'sentry.io',
  'wix.com', 'wordpress.com', 'squarespace.com', 'weebly.com',
  'googleapis.com', 'googleusercontent.com', 'gstatic.com',
  'w3.org', 'schema.org', 'facebook.com', 'twitter.com',
  'instagram.com', 'youtube.com', 'linkedin.com'
];

// Contact page paths to try (in order)
const CONTACT_PATHS = [
  '/contact',
  '/contact-us',
  '/contacts',
  '/iletisim',
  '/iletişim',
  '/about',
  '/about-us',
  '/kontakt',
  '/kontakte',
  '/contatti',
  '/contacto',
  '/en/contact',
  '/tr/iletisim'
];

/**
 * Check if an email is junk (should be excluded entirely)
 */
function isJunkEmail(email) {
  if (!email) return true;
  const lower = email.toLowerCase();
  return JUNK_EMAIL_DOMAINS.some(d => lower.endsWith('@' + d) || lower.includes('.' + d));
}

/**
 * Check if an email prefix is generic
 */
function isGenericEmail(email) {
  if (!email) return false;
  const prefix = email.toLowerCase().split('@')[0];
  return GENERIC_PREFIXES.includes(prefix);
}

/**
 * Extract emails from a page (mailto links + regex scan)
 */
async function extractEmailsFromPage(page) {
  return await page.evaluate((junkDomains) => {
    const emails = new Set();

    // 1. mailto: links
    const mailtoLinks = document.querySelectorAll('a[href^="mailto:"]');
    mailtoLinks.forEach(link => {
      const href = link.getAttribute('href') || '';
      const email = href.replace('mailto:', '').split('?')[0].trim().toLowerCase();
      if (email && email.includes('@')) {
        emails.add(email);
      }
    });

    // 2. Regex scan on page text + href attributes
    const bodyText = document.body ? document.body.innerText : '';
    const hrefTexts = Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.getAttribute('href') || '')
      .join(' ');
    const allText = bodyText + ' ' + hrefTexts;

    const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    let match;
    while ((match = regex.exec(allText)) !== null) {
      const email = match[0].toLowerCase();
      // Filter junk domains in-browser
      const isJunk = junkDomains.some(d => email.endsWith('@' + d) || email.includes('.' + d));
      if (!isJunk) {
        emails.add(email);
      }
    }

    return Array.from(emails);
  }, JUNK_EMAIL_DOMAINS);
}

/**
 * Main miner function
 *
 * @param {import('playwright').Page} page - Playwright Page object
 * @param {string} url - Company website URL
 * @param {Object} config - Configuration options
 * @param {number} config.timeout_ms - Total execution timeout (default 20000)
 * @param {number} config.page_timeout_ms - Per-page navigation timeout (default 10000)
 * @returns {Array} Array of contact results
 */
async function runContactPageMiner(page, url, config = {}) {
  const totalTimeout = config.timeout_ms || 20000;
  const pageTimeout = config.page_timeout_ms || 10000;
  const startTime = Date.now();

  console.log(`[contactPageMiner] Starting: ${url}`);

  // Normalize base URL
  let baseUrl;
  try {
    const parsed = new URL(url);
    baseUrl = `${parsed.protocol}//${parsed.hostname}${parsed.port ? ':' + parsed.port : ''}`;
  } catch (e) {
    console.log(`[contactPageMiner] Invalid URL: ${url}`);
    return [];
  }

  const results = [];

  /**
   * Try to extract emails from a given URL path
   * Returns true if emails were found (signals to stop)
   */
  async function tryPage(targetUrl, sourcePath) {
    // Check total timeout
    if (Date.now() - startTime > totalTimeout) {
      console.log(`[contactPageMiner] Total timeout reached (${totalTimeout}ms)`);
      return true; // stop
    }

    try {
      await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: pageTimeout
      });

      // Brief wait for dynamic content
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});

      const emails = await extractEmailsFromPage(page);

      if (emails.length > 0) {
        console.log(`[contactPageMiner] Found ${emails.length} email(s) on ${sourcePath}`);

        for (const email of emails) {
          results.push({
            website: url,
            email: email,
            email_source_page: sourcePath,
            is_generic: isGenericEmail(email),
            company_name: null // set by caller
          });
        }
        return true; // found emails, stop
      }
    } catch (err) {
      // Navigation failure — skip this path
      console.log(`[contactPageMiner] Failed to load ${sourcePath}: ${err.message}`);
    }

    return false; // no emails found, continue
  }

  // Step 1: Try homepage
  const homepageFound = await tryPage(url, '/');
  if (homepageFound && results.length > 0) {
    console.log(`[contactPageMiner] Done: ${results.length} email(s) from homepage`);
    return results;
  }

  // If homepage URL is not the root, also try root
  try {
    const parsed = new URL(url);
    if (parsed.pathname !== '/' && parsed.pathname !== '') {
      const rootFound = await tryPage(baseUrl + '/', '/');
      if (rootFound && results.length > 0) {
        console.log(`[contactPageMiner] Done: ${results.length} email(s) from root`);
        return results;
      }
    }
  } catch (e) {}

  // Step 2: Try contact/about page paths
  for (const path of CONTACT_PATHS) {
    if (Date.now() - startTime > totalTimeout) {
      console.log(`[contactPageMiner] Total timeout reached, stopping path iteration`);
      break;
    }

    const targetUrl = baseUrl + path;
    const found = await tryPage(targetUrl, path);
    if (found && results.length > 0) {
      console.log(`[contactPageMiner] Done: ${results.length} email(s) from ${path}`);
      return results;
    }
  }

  console.log(`[contactPageMiner] No emails found on ${url} (checked ${CONTACT_PATHS.length + 2} pages in ${Date.now() - startTime}ms)`);
  return results;
}

module.exports = { runContactPageMiner };
