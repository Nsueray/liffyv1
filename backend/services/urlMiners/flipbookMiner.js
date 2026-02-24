/**
 * LIFFY Flipbook Miner v1.0
 *
 * Extracts contact data from Flipbuilder/FlipHTML5/AnyFlip basic-html flipbook pages.
 * These flipbooks store each page as a standalone HTML file (page1.html, page2.html, ...).
 * Text is real (not image-based), embedded in div-based layouts.
 *
 * Strategy:
 *   Phase 1 — Discovery: navigate to page1, detect total page count from nav links
 *   Phase 2 — Extraction: iterate pages, extract text, find emails + context fields
 *   Phase 3 — Dedup + output
 *
 * Usage (module only — browser lifecycle managed by flowOrchestrator wrapper):
 *   const { runFlipbookMiner } = require("./flipbookMiner");
 *   const cards = await runFlipbookMiner(page, url, config);
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
const PHONE_RE = /(?:☎\s*)?(?:\+?\d{1,3}[\s\-.]?)?\(?\d{2,4}\)?[\s\-.]?\d{2,4}[\s\-.]?\d{2,8}/g;
const WEBSITE_RE = /(?:https?:\/\/)?(?:www\.)[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}(?:\/\S*)?/gi;
const BOX_RE = /(?:P\.?\s*O\.?\s*Box\s*\w+[^\n]*)/i;

const EMAIL_BLACKLIST = [
  '.png', '.jpg', '.jpeg', '.gif', '.svg',
  'example.com', 'test.com', 'wix.com', 'sentry.io',
  'noreply', 'no-reply', '@sentry', '@wix',
];

/**
 * Derive the base URL for page{N}.html from the input URL.
 * Input:  https://online.flipbuilder.com/rxlp/jhjm/files/basic-html/page1.html
 * Output: https://online.flipbuilder.com/rxlp/jhjm/files/basic-html/page
 */
function derivePageBase(inputUrl) {
  // Match page<digits>.html at the end
  const match = inputUrl.match(/^(.*\/page)\d+(\.html?)$/i);
  if (match) {
    return { base: match[1], ext: match[2] };
  }
  // Fallback: assume page1.html convention
  const lastSlash = inputUrl.lastIndexOf('/');
  return { base: inputUrl.substring(0, lastSlash + 1) + 'page', ext: '.html' };
}

/**
 * Main mining function.
 * @param {import('playwright').Page} page - Playwright Page object
 * @param {string} url - Target URL
 * @param {Object} config - Job config
 * @returns {Promise<Array>} Raw card array
 */
async function runFlipbookMiner(page, url, config = {}) {
  const maxPages = config.max_pages || 50;
  const delayMs = config.delay_ms || 500;
  const totalTimeout = config.total_timeout || 600000; // 10 min
  const startTime = Date.now();

  console.log(`[flipbookMiner] Starting: ${url}`);

  const { base, ext } = derivePageBase(url);
  console.log(`[flipbookMiner] Page base: ${base}*${ext}, max_pages: ${maxPages}`);

  // ========================================
  // PHASE 1: Discover total page count
  // ========================================
  console.log('[flipbookMiner] Phase 1: Discovering total page count...');

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle').catch(() => {});
  } catch (err) {
    console.warn(`[flipbookMiner] Navigation warning: ${err.message}`);
  }

  // Find max page number from navigation links
  let totalPages = await page.evaluate(() => {
    let max = 1;
    const links = document.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const m = href.match(/page(\d+)\.html?/i);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    }
    // Also check text content for "of N" pattern
    const bodyText = document.body.innerText || '';
    const ofMatch = bodyText.match(/of\s+(\d+)/i);
    if (ofMatch) {
      const n = parseInt(ofMatch[1], 10);
      if (n > max && n < 5000) max = n;
    }
    return max;
  });

  // If nav only shows nearby pages (e.g. 1-10), probe further with binary search
  if (totalPages < 100) {
    const probeTargets = [100, 200, 500, 834, 1000];
    for (const probe of probeTargets) {
      if (probe <= totalPages) continue;
      try {
        const probeUrl = `${base}${probe}${ext}`;
        const resp = await page.evaluate(async (u) => {
          const r = await fetch(u, { method: 'HEAD' });
          return r.ok;
        }, probeUrl);
        if (resp) {
          totalPages = Math.max(totalPages, probe);
        } else {
          break; // This probe failed, no need to try higher
        }
      } catch { break; }
    }

    // Binary search between last known good and first failed
    if (totalPages >= 100) {
      let lo = totalPages;
      let hi = totalPages + 200;
      // First find upper bound
      try {
        const resp = await page.evaluate(async (u) => {
          const r = await fetch(u, { method: 'HEAD' });
          return r.ok;
        }, `${base}${hi}${ext}`);
        if (resp) hi = hi + 500;
      } catch { /* keep hi */ }

      while (lo < hi - 1) {
        const mid = Math.floor((lo + hi) / 2);
        try {
          const resp = await page.evaluate(async (u) => {
            const r = await fetch(u, { method: 'HEAD' });
            return r.ok;
          }, `${base}${mid}${ext}`);
          if (resp) lo = mid;
          else hi = mid;
        } catch { hi = mid; }
      }
      totalPages = lo;
    }
  }

  const pagesToMine = Math.min(totalPages, maxPages);
  console.log(`[flipbookMiner] Phase 1 complete: ${totalPages} total pages detected, mining ${pagesToMine}`);

  // ========================================
  // PHASE 2: Extract contacts from each page
  // ========================================
  console.log('[flipbookMiner] Phase 2: Extracting contacts from pages...');

  const seenEmails = new Set();
  const contacts = [];
  let totalEmailsFound = 0;

  for (let i = 1; i <= pagesToMine; i++) {
    if (Date.now() - startTime > totalTimeout) {
      console.log('[flipbookMiner] Timeout reached');
      break;
    }

    const pageUrl = `${base}${i}${ext}`;

    try {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

      const pageText = await page.evaluate(() => {
        return document.body ? document.body.innerText : '';
      });

      if (!pageText || pageText.length < 20) continue;

      // Find all emails on this page
      const emails = pageText.match(EMAIL_RE) || [];

      for (const rawEmail of emails) {
        const email = rawEmail.toLowerCase();

        if (seenEmails.has(email)) continue;
        if (EMAIL_BLACKLIST.some(bl => email.includes(bl))) continue;

        seenEmails.add(email);
        totalEmailsFound++;

        // Extract context around this email
        const pos = pageText.indexOf(rawEmail);
        const ctxStart = Math.max(0, pos - 500);
        const ctxEnd = Math.min(pageText.length, pos + 200);
        const context = pageText.substring(ctxStart, ctxEnd);

        const card = {
          company_name: extractCompany(context, rawEmail),
          email: email,
          phone: extractPhone(context),
          website: extractWebsite(context, email),
          address: extractAddress(context),
          country: null,
          contact_name: null,
          job_title: null,
          source_url: pageUrl,
        };

        contacts.push(card);
      }
    } catch (err) {
      console.warn(`[flipbookMiner] Page ${i} error: ${err.message}`);
    }

    // Delay between pages
    if (i < pagesToMine) {
      await new Promise(r => setTimeout(r, delayMs));
    }

    // Progress logging every 10 pages
    if (i % 10 === 0 || i === pagesToMine) {
      console.log(`[flipbookMiner] Progress: ${i}/${pagesToMine} pages, ${totalEmailsFound} emails`);
    }
  }

  // ========================================
  // PHASE 3: Output
  // ========================================
  console.log(`[flipbookMiner] Final: ${contacts.length} contacts from ${pagesToMine} pages`);

  return contacts;
}

// ── Field extraction helpers ──

function extractCompany(context, email) {
  // Look for labeled company
  const labeled = context.match(/Company[\s]*[:\-][\s]*([^\n]+)/i);
  if (labeled && labeled[1]) return cleanField(labeled[1]);

  // Get text BEFORE the email — company name is usually above/before
  const emailPos = context.indexOf(email) || context.indexOf(email.toLowerCase());
  const textBefore = emailPos > 0 ? context.substring(0, emailPos) : context;

  // Split into lines, look backwards for a capitalized line that looks like a company
  const lines = textBefore.split(/\n/).map(l => l.trim()).filter(l => l.length > 2);

  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) {
    const line = lines[i];
    // Skip label lines
    if (/^(Mobile|Phone|Tel|Email|Fax|Address|City|Country|Website|Box|P\.?\s*O)/i.test(line)) continue;
    // Skip lines that are just numbers/symbols
    if (/^[\d\s☎+\-().]+$/.test(line)) continue;
    // Must start with uppercase and be reasonable length
    if (/^[A-Z]/.test(line) && line.length > 3 && line.length < 120) {
      // Clean trailing page refs, dots, etc.
      const cleaned = line.replace(/\.{2,}.*$/, '').replace(/\s*Pg\s*\d*$/, '').trim();
      if (cleaned.length > 2) return cleaned;
    }
  }

  return null;
}

function extractPhone(context) {
  // Labeled phone
  const labeled = context.match(/(?:Mobile|Phone|Tel|GSM|Cell|☎)[\s]*[:\-]?\s*([+\d\s\-().]+)/i);
  if (labeled && labeled[1]) {
    const phone = labeled[1].trim();
    const digits = phone.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15) return phone;
  }

  // Regex match
  const matches = context.match(PHONE_RE) || [];
  for (const m of matches) {
    const digits = m.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15) return m.trim();
  }

  return null;
}

function extractWebsite(context, email) {
  // Labeled website
  const labeled = context.match(/(?:Website|Web|URL)[\s]*[:\-][\s]*((?:https?:\/\/)?(?:www\.)?[^\s]+)/i);
  if (labeled && labeled[1]) {
    let w = labeled[1].trim();
    if (!w.startsWith('http')) w = 'https://' + w;
    return w;
  }

  // www. pattern
  const urls = context.match(WEBSITE_RE) || [];
  for (const u of urls) {
    if (!/facebook|twitter|linkedin|instagram|youtube/i.test(u)) {
      return u.startsWith('http') ? u : 'https://' + u;
    }
  }

  return null;
}

function extractAddress(context) {
  // P.O. Box pattern
  const boxMatch = context.match(BOX_RE);
  if (boxMatch) return cleanField(boxMatch[0]);

  // Labeled address
  const labeled = context.match(/(?:Address|Location)[\s]*[:\-][\s]*([^\n]+)/i);
  if (labeled && labeled[1]) return cleanField(labeled[1]);

  return null;
}

function cleanField(value) {
  if (!value) return null;
  const cleaned = value.replace(/\.{2,}/g, '').replace(/\s+/g, ' ').trim();
  return cleaned.length > 1 ? cleaned : null;
}

module.exports = { runFlipbookMiner };
