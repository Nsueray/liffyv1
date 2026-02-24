/**
 * LIFFY Flipbook Miner v2.0
 *
 * Extracts contact data from Flipbuilder/FlipHTML5/AnyFlip basic-html flipbook pages.
 * These flipbooks store each page as a standalone HTML file (page1.html, page2.html, ...).
 *
 * Two extraction paths:
 *   Path A — Column-position extraction for <pre><code> multi-column layouts
 *            (e.g. Ghana Yellow Pages: 4 columns side-by-side in plain text)
 *   Path B — Bold map + htmlToLines for tag-based layouts (<br>, <b>, <div>)
 *
 * Strategy:
 *   Phase 1 — Discovery: navigate to page1, detect total page count from nav links
 *   Phase 2 — Extraction: iterate pages, dual-path extract, find emails + context fields
 *   Phase 3 — Dedup + output
 *
 * Usage (module only — browser lifecycle managed by flowOrchestrator wrapper):
 *   const { runFlipbookMiner } = require("./flipbookMiner");
 *   const cards = await runFlipbookMiner(page, url, config);
 */

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

      // Dual-path extraction inside page.evaluate — runs in browser context
      const pageResults = await page.evaluate(() => {
        if (!document.body) return [];

        const results = [];
        const seenInPage = new Set();
        const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        const skipPrefix = /^(noreply|no-reply|mailer-daemon|postmaster|hostmaster|abuse|webmaster|test)@/i;

        // ═══════════════════════════════════════════════════
        // PATH A: <pre>/<code> column-position extraction
        // For flipbooks with multi-column plain text layouts
        // (e.g. Ghana Yellow Pages: <pre><code> with 4 cols)
        // ═══════════════════════════════════════════════════

        // Isolate the segment within a raw slice that belongs to THIS column.
        // Raw slices often bleed into adjacent columns. Split by large
        // whitespace gaps (3+ spaces) and return the segment whose position
        // best overlaps with the email's position within the slice.
        function isolateSegment(rawSlice, emailPosInSlice) {
          // Replace dot-padding with spaces for splitting
          const normalized = rawSlice.replace(/\.{2,}/g, '   ');
          // Split by 3+ spaces
          const parts = [];
          let idx = 0;
          for (const seg of normalized.split(/\s{3,}/)) {
            const trimmed = seg.trim();
            if (trimmed) {
              const segStart = rawSlice.indexOf(seg.trim(), Math.max(0, idx - 5));
              parts.push({ text: trimmed, start: segStart >= 0 ? segStart : idx });
            }
            idx += seg.length + 3;
          }
          if (parts.length <= 1) {
            return rawSlice.replace(/\.{2,}/g, ' ').trim();
          }
          // Pick the segment closest to the email's position
          let best = parts[0];
          let bestDist = Math.abs(parts[0].start - emailPosInSlice);
          for (let p = 1; p < parts.length; p++) {
            const dist = Math.abs(parts[p].start - emailPosInSlice);
            if (dist < bestDist) {
              bestDist = dist;
              best = parts[p];
            }
          }
          return best.text;
        }

        const preElements = document.querySelectorAll('pre');
        for (const pre of preElements) {
          const text = pre.textContent || '';
          if (!text.includes('@')) continue;

          const lines = text.split('\n');

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.includes('@')) continue;

            // Find all emails on this line with their character positions
            const emailsOnLine = [];
            emailRe.lastIndex = 0;
            let match;
            while ((match = emailRe.exec(line)) !== null) {
              const emLower = match[0].toLowerCase();
              if (!skipPrefix.test(emLower) && !seenInPage.has(emLower)) {
                emailsOnLine.push({ email: emLower, pos: match.index, len: match[0].length });
              }
            }
            if (emailsOnLine.length === 0) continue;

            // Determine column boundaries using midpoints between emails
            for (let e = 0; e < emailsOnLine.length; e++) {
              const em = emailsOnLine[e];
              const colStart = e === 0 ? 0
                : Math.floor((emailsOnLine[e - 1].pos + emailsOnLine[e - 1].len + em.pos) / 2);
              const colEnd = e === emailsOnLine.length - 1 ? 9999
                : Math.floor((em.pos + em.len + emailsOnLine[e + 1].pos) / 2);
              // Email's relative position within the column slice
              const emailRelPos = em.pos - colStart;

              let company_name = null;
              let phone = null;
              let address = null;
              let website = null;

              // Scan upward in the same column (up to 6 lines)
              for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
                const rawSlice = lines[j].substring(colStart, colEnd);
                const cleaned = isolateSegment(rawSlice, emailRelPos);
                if (!cleaned || cleaned.length < 2) continue;

                // Phone detection (☎ symbol, tel/phone label, or Ghana number pattern)
                if (!phone) {
                  const phoneMatch = cleaned.match(/☎\s*([\d\s\-+()]+)/)
                    || cleaned.match(/(?:Tel|Phone|Mob)[:\s]*([\d\s\-+()]+)/i);
                  if (phoneMatch) {
                    const digits = phoneMatch[1].replace(/\D/g, '');
                    if (digits.length >= 7 && digits.length <= 15) {
                      phone = phoneMatch[1].trim();
                    }
                  }
                  if (!phone) {
                    const numMatch = cleaned.match(/((?:\+?233|0)[234]\d[\s\-]?[\d\s\-]{6,})/);
                    if (numMatch) {
                      const digits = numMatch[1].replace(/\D/g, '');
                      if (digits.length >= 7 && digits.length <= 15) phone = numMatch[1].trim();
                    }
                  }
                }

                // Address: P.O. Box / Box
                if (!address) {
                  const boxMatch = cleaned.match(/((?:P\.?\s*O\.?\s*)?Box\s+[\w]+[^☎]*)/i);
                  if (boxMatch) {
                    address = boxMatch[1].replace(/\s+/g, ' ').trim();
                  }
                }

                // Company name: first non-phone, non-address, non-email line going upward
                if (!company_name) {
                  if (cleaned.includes('@')) continue;
                  if (/☎/.test(cleaned)) continue;
                  if (/^[\d\s+\-().]+$/.test(cleaned)) continue;
                  if (/^(Box|P\.?\s*O)/i.test(cleaned)) continue;
                  if (/\b(Road|Street|Rd\b|Ave\b|Avenue|Lane|Estate|Floor|Arcade|Close|Crescent|Highway|Blvd|Drive|Junction|Roundabout|Link|Loop)\b/i.test(cleaned)) continue;
                  if (/^(No\.?\s*\d|Adj\.|Opp\.|Near\s|Behind\s|Off\s|Beside\s)/i.test(cleaned)) continue;
                  if (/^\d+[\s,]+(Road|St|Street|Ave)/i.test(cleaned)) continue;
                  company_name = cleaned;
                }
              }

              // Look below (1-2 lines) for website
              for (let j = i + 1; j <= Math.min(lines.length - 1, i + 2); j++) {
                const rawSlice = lines[j].substring(colStart, colEnd);
                const cleaned = isolateSegment(rawSlice, emailRelPos);
                if (!cleaned) continue;
                const wm = cleaned.match(/((?:https?:\/\/)?www\.[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s]*)/i);
                if (wm) { website = wm[1].trim(); break; }
              }

              seenInPage.add(em.email);
              results.push({ email: em.email, company_name, phone, website, address });
            }
          }
        }

        // ═══════════════════════════════════════════════════
        // PATH B: Bold map + htmlToLines (regular HTML)
        // For flipbooks with <br>/<b> tag-based layouts
        // ═══════════════════════════════════════════════════

        // Bold/heading → email map
        const boldMap = new Map();
        const bolds = document.querySelectorAll('b, strong, h3, h4, h5, h6');
        for (const el of bolds) {
          const companyCandidate = el.textContent.trim();
          if (!companyCandidate || companyCandidate.length < 2 || companyCandidate.length > 200) continue;
          if (companyCandidate.includes('@') || /^[\d☎+\(]/.test(companyCandidate)) continue;
          if (/^(Box|P\.?O|Tel|Phone|Fax|Email|Website|www\.|http)/i.test(companyCandidate)) continue;

          const container = el.closest('td, div, p, section, article') || el.parentElement;
          if (!container) continue;

          const containerText = container.textContent || '';
          const emailMatches = containerText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
          if (emailMatches) {
            for (const em of emailMatches) {
              boldMap.set(em.toLowerCase(), companyCandidate);
            }
          }
        }

        // innerHTML → clean lines (collapses whitespace — fine for tag-based layouts)
        function htmlToLines(html) {
          let text = html
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/?(p|div|tr|li|h[1-6]|blockquote|section|article)[^>]*>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#?\w+;/g, '')
            .replace(/[ \t]+/g, ' ');
          return text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        }

        const lines = htmlToLines(document.body.innerHTML);
        const labelSkip = /^(Mobile|Phone|Tel|Email|Fax|Address|City|Country|Website|Box|P\.?\s*O)/i;
        const addressSkip = /^(No\.?\s*\d|Adj\.|Opp\.|Near\s|Behind\s|Off\s|Beside\s|Along\s|Next\s+to\s|Opposite\s|H\/No\.|Plot\s|Block\s|Km\s?\d)/i;
        const streetNum = /^\d+[\s,]+(Road|St|Street|Ave|Avenue|Lane|Drive|Rd|Blvd|Link|Loop|Close|Crescent)/i;
        const companySuffix = /\b(Ltd|Limited|Co\.|Inc|Corp|GmbH|Enterprise|Enterprises|Services|Group|Associates|Partners|Ventures|Agency|Foundation|Ministry|S\.?A\.?|Pvt|Pty|PLC|LLC|LLP)\b/i;
        const addressKeyword = /\b(Road|Street|Ave|Avenue|Lane|Estate|Junction|Roundabout|Highway|Blvd|Drive|Close|Crescent|Link|Loop)\b/i;

        for (let i = 0; i < lines.length; i++) {
          const lineEmails = lines[i].match(emailRe);
          if (!lineEmails) continue;

          for (const rawEmail of lineEmails) {
            const emailLower = rawEmail.toLowerCase();
            if (seenInPage.has(emailLower)) continue;
            if (skipPrefix.test(rawEmail)) continue;

            // Company name: bold map → line scan
            let company_name = boldMap.get(emailLower) || null;

            if (!company_name) {
              const candidates = [];
              for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
                const candidate = lines[j];
                if (!candidate || candidate.length < 3 || candidate.length > 200) continue;
                if (candidate.includes('@')) continue;
                if (/^[\d\s☎+\-().]+$/.test(candidate)) continue;
                if (labelSkip.test(candidate)) continue;
                if (addressSkip.test(candidate)) continue;
                if (streetNum.test(candidate)) continue;
                if (!/^[A-Z]/.test(candidate)) continue;

                const cleaned = candidate.replace(/\.{2,}.*$/, '').replace(/\s*Pg\s*\d*$/, '').trim();
                if (cleaned.length < 3) continue;

                let score = 0;
                if (companySuffix.test(cleaned)) score += 10;
                const words = cleaned.split(/\s+/);
                if (words.length >= 2 && cleaned === cleaned.toUpperCase()) score += 5;
                if (cleaned.length < 60) score += 2;
                if (addressKeyword.test(cleaned)) score -= 10;
                if (/^\d/.test(cleaned)) score -= 5;
                if (cleaned.length > 100) score -= 3;

                candidates.push({ text: cleaned, score });
              }

              if (candidates.length > 0) {
                candidates.sort((a, b) => b.score - a.score);
                if (candidates[0].score >= 0) {
                  company_name = candidates[0].text;
                }
              }
            }

            // Phone: scan nearby lines (+-3)
            let phone = null;
            for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3); j++) {
              const pl = lines[j];
              const telSymbol = pl.match(/☎\s*([\d\s\-+()]+)/);
              if (telSymbol) { phone = telSymbol[1].trim(); break; }
              const telLabel = pl.match(/(?:Tel|Phone|Mob)[:\s]*([\d\s\-+()]+)/i);
              if (telLabel) { phone = telLabel[1].trim(); break; }
              if (!pl.includes('@') && !/www\./i.test(pl)) {
                const ghPhone = pl.match(/(?:^|\s)((?:\+?233|0)[234]\d[\s\-]?[\d\s\-]{6,})/);
                if (ghPhone) { phone = ghPhone[1].trim(); break; }
              }
            }
            if (phone) {
              const digits = phone.replace(/\D/g, '');
              if (digits.length < 7 || digits.length > 15) phone = null;
            }

            // Website: scan nearby lines (+-3)
            let website = null;
            for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3); j++) {
              const wm = lines[j].match(/((?:https?:\/\/)?www\.[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s]*)/i);
              if (wm) { website = wm[1].trim(); break; }
            }

            // Address: scan nearby lines (+-3)
            let address = null;
            for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3); j++) {
              const boxMatch = lines[j].match(/(?:P\.?\s*O\.?\s*Box\s*\w+[^\n]*)/i);
              if (boxMatch) { address = boxMatch[0].trim(); break; }
            }

            seenInPage.add(emailLower);
            results.push({ email: emailLower, company_name, phone, website, address });
          }
        }

        return results;
      });

      // Dedup and collect
      for (const r of pageResults) {
        if (seenEmails.has(r.email)) continue;
        if (EMAIL_BLACKLIST.some(bl => r.email.includes(bl))) continue;

        seenEmails.add(r.email);
        totalEmailsFound++;

        contacts.push({
          company_name: r.company_name,
          email: r.email,
          phone: r.phone,
          website: r.website,
          address: r.address,
          country: null,
          contact_name: null,
          job_title: null,
          source_url: pageUrl,
        });
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

module.exports = { runFlipbookMiner };
