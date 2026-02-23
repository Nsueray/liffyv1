/**
 * LIFFY Member Table Miner v1.0
 *
 * Extracts data from HTML tables on member/exhibitor list pages.
 * Targets: association sites, chambers of commerce, industry federations.
 * Returns raw card data — normalization handled by flowOrchestrator.
 *
 * Strategy:
 *   1. Navigate, find all <table> elements
 *   2. Analyze header row → semantic column mapping
 *   3. Parse each data row using column mapping
 *   4. Fallback: content-based detection if no header row
 *
 * Usage (module only — browser lifecycle managed by flowOrchestrator wrapper):
 *   const { runMemberTableMiner } = require("./memberTableMiner");
 *   const cards = await runMemberTableMiner(page, url, config);
 */

// ──────────────────────────────────────────────
// Header keyword → field mapping (multi-language)
// ──────────────────────────────────────────────
const HEADER_KEYWORDS = {
  company_name: [
    'company', 'organization', 'organisation', 'firm', 'firma',
    'şirket', 'kuruluş', 'member', 'üye', 'exhibitor',
    'name of the company', 'name of company', 'company name',
    'member name', 'organization name'
  ],
  email: [
    'email', 'e-mail', 'mail', 'e mail', 'email address',
    'e-posta', 'eposta',
    'contact details', 'contact info', 'contact information',
    'details', 'info'
  ],
  phone: [
    'phone', 'tel', 'telephone', 'mobile', 'contact no',
    'phone no', 'telefon', 'fax', 'ph no', 'mob'
  ],
  contact_name: [
    'contact person', 'person', 'representative',
    'contact name', 'rep', 'kişi', 'temsilci', 'yetkili',
    'name of contact', 'authorized person'
  ],
  city: [
    'city', 'location', 'place', 'şehir', 'il', 'town'
  ],
  address: [
    'address', 'adres', 'addr', 'full address', 'postal address'
  ],
  country: [
    'country', 'ülke', 'nation'
  ],
  website: [
    'website', 'web', 'url', 'site', 'homepage', 'web site'
  ]
};

// Email regex
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// Phone regex — liberal, cleaned later
const PHONE_REGEX = /(?:\+?\d[\d\s\-().]{6,19}\d)/g;

// Company suffixes for content-based detection
const COMPANY_SUFFIXES = [
  'PVT', 'LTD', 'INC', 'CORP', 'LLC', 'GMBH', 'AG', 'SA', 'SRL',
  'S.P.A', 'S.A.', 'CO.', 'A.S.', 'A.Ş.', 'ŞTİ', 'LLP', 'PTY',
  'BV', 'NV', 'OY', 'AB', 'KG', 'E.V.'
];

// Contact name prefixes
const NAME_PREFIXES = ['MR.', 'MRS.', 'MS.', 'DR.', 'PROF.', 'MR ', 'MRS ', 'MS ', 'DR '];

/**
 * Main mining function
 * @param {import('playwright').Page} page - Playwright Page object
 * @param {string} url - Target URL
 * @param {Object} config - Job config
 * @returns {Promise<Array>} Raw card array
 */
async function runMemberTableMiner(page, url, config = {}) {
  const waitMs = config.delay_ms || 2000;

  console.log(`[memberTableMiner] Starting: ${url}`);

  // Navigate
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(waitMs);

  // Scroll to trigger lazy content
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);

  // Extract all tables' raw data inside the browser
  const tablesData = await page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    return tables.map(table => {
      const rows = Array.from(table.querySelectorAll('tr'));
      return rows.map(row => {
        const cells = Array.from(row.querySelectorAll('td, th'));
        return cells.map(cell => ({
          text: cell.innerText.trim(),
          html: cell.innerHTML,
          isHeader: cell.tagName === 'TH'
        }));
      });
    });
  });

  console.log(`[memberTableMiner] Found ${tablesData.length} tables`);

  const allCards = [];

  for (const tableRows of tablesData) {
    if (tableRows.length < 2) continue; // Need at least header + 1 data row

    // Try header-based mapping first
    const mapping = detectHeaderMapping(tableRows);

    if (mapping) {
      console.log(`[memberTableMiner] Header mapping found: ${JSON.stringify(mapping.fieldMap)}`);
      const cards = parseWithHeaderMapping(tableRows, mapping);
      allCards.push(...cards);
    } else {
      // Fallback: content-based detection
      console.log(`[memberTableMiner] No header — trying content-based detection`);
      const cards = parseWithContentDetection(tableRows);
      allCards.push(...cards);
    }
  }

  // Dedup by email
  const seen = new Set();
  const dedupCards = [];
  for (const card of allCards) {
    if (!card.email) continue;
    const key = card.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    dedupCards.push(card);
  }

  console.log(`[memberTableMiner] Extracted ${dedupCards.length} unique contacts (from ${allCards.length} raw)`);

  return dedupCards;
}

// ──────────────────────────────────────────────
// Header detection
// ──────────────────────────────────────────────

/**
 * Detect header row and build column → field mapping
 * @param {Array} tableRows - Array of rows, each row is array of cells
 * @returns {Object|null} { headerRowIndex, fieldMap: { colIndex: fieldName } }
 */
function detectHeaderMapping(tableRows) {
  // Check first 3 rows for potential header
  const checkRows = Math.min(3, tableRows.length);

  for (let rowIdx = 0; rowIdx < checkRows; rowIdx++) {
    const row = tableRows[rowIdx];
    if (row.length < 2) continue;

    // Is this a header row?
    const allTh = row.every(cell => cell.isHeader);
    const hasHeaderKeywords = row.some(cell => {
      const lower = cell.text.toLowerCase();
      return Object.values(HEADER_KEYWORDS).some(keywords =>
        keywords.some(kw => lower.includes(kw))
      );
    });

    if (!allTh && !hasHeaderKeywords) continue;

    // Build field map
    const fieldMap = {};
    let matchCount = 0;

    for (let colIdx = 0; colIdx < row.length; colIdx++) {
      const cellText = row[colIdx].text.toLowerCase().trim();
      if (!cellText) continue;

      let bestField = null;
      let bestScore = 0;

      for (const [field, keywords] of Object.entries(HEADER_KEYWORDS)) {
        for (const kw of keywords) {
          let score = 0;

          // Exact match (whole cell text) — highest priority
          if (cellText === kw) {
            score = 100 + kw.length;
          }
          // Cell starts with keyword
          else if (cellText.startsWith(kw)) {
            score = 50 + kw.length;
          }
          // Keyword contained in cell
          else if (cellText.includes(kw)) {
            score = 10 + kw.length;
          }

          // Longer keyword match = more specific = better
          if (score > bestScore) {
            bestField = field;
            bestScore = score;
          }
        }
      }

      if (bestField) {
        fieldMap[colIdx] = bestField;
        matchCount++;
      }
    }

    // Need at least 2 mapped fields to consider this a valid header
    if (matchCount >= 2) {
      return { headerRowIndex: rowIdx, fieldMap };
    }
  }

  return null;
}

// ──────────────────────────────────────────────
// Parse with header mapping
// ──────────────────────────────────────────────

/**
 * Parse data rows using header column mapping
 */
function parseWithHeaderMapping(tableRows, mapping) {
  const { headerRowIndex, fieldMap } = mapping;
  const cards = [];

  for (let i = headerRowIndex + 1; i < tableRows.length; i++) {
    const row = tableRows[i];
    if (row.length < 2) continue;

    const card = {
      company_name: null,
      email: null,
      phone: null,
      website: null,
      country: null,
      city: null,
      address: null,
      contact_name: null,
      job_title: null
    };

    const allEmails = [];

    for (const [colIdx, field] of Object.entries(fieldMap)) {
      const cell = row[parseInt(colIdx)];
      if (!cell) continue;

      const text = cell.text;
      const html = cell.html;

      switch (field) {
        case 'company_name':
          card.company_name = extractCompanyFromCell(text, html);
          // Also check for address below company name
          if (!card.address) {
            card.address = extractAddressFromCompanyCell(text);
          }
          break;

        case 'email':
          extractEmailsFromCell(text, html, allEmails);
          // Also extract phone from same cell (common pattern: email + "Ph: xxx")
          if (!card.phone) {
            card.phone = extractPhoneFromText(text);
          }
          break;

        case 'phone':
          card.phone = extractPhoneFromText(text);
          break;

        case 'contact_name':
          card.contact_name = text.trim() || null;
          break;

        case 'city':
          card.city = text.trim() || null;
          break;

        case 'address':
          card.address = text.trim() || null;
          break;

        case 'country':
          card.country = text.trim() || null;
          break;

        case 'website':
          card.website = extractWebsiteFromCell(text, html);
          break;
      }
    }

    // Also scan unmapped cells for emails (some tables have merged columns)
    for (let colIdx = 0; colIdx < row.length; colIdx++) {
      if (fieldMap[colIdx]) continue; // Already mapped
      const cell = row[colIdx];
      if (cell) {
        extractEmailsFromCell(cell.text, cell.html, allEmails);
      }
    }

    // Assign primary email
    if (allEmails.length > 0) {
      card.email = allEmails[0];
    }

    // Skip rows without email
    if (!card.email) continue;

    cards.push(card);
  }

  return cards;
}

// ──────────────────────────────────────────────
// Parse with content detection (no header)
// ──────────────────────────────────────────────

/**
 * Parse table without header using content-based detection
 */
function parseWithContentDetection(tableRows) {
  const cards = [];

  // First pass: figure out which columns contain what
  const colSignals = {}; // colIdx → { email: N, company: N, phone: N, name: N, city: N }

  const sampleSize = Math.min(10, tableRows.length);
  for (let i = 0; i < sampleSize; i++) {
    const row = tableRows[i];
    for (let colIdx = 0; colIdx < row.length; colIdx++) {
      if (!colSignals[colIdx]) {
        colSignals[colIdx] = { email: 0, company: 0, phone: 0, name: 0, city: 0 };
      }

      const text = row[colIdx].text;
      const html = row[colIdx].html;

      // Email signal
      if (EMAIL_REGEX.test(text) || EMAIL_REGEX.test(html)) {
        colSignals[colIdx].email++;
        EMAIL_REGEX.lastIndex = 0;
      }

      // Company signal (uppercase + suffixes)
      const upperText = text.toUpperCase();
      if (COMPANY_SUFFIXES.some(s => upperText.includes(s))) {
        colSignals[colIdx].company++;
      }

      // Name signal (MR./MRS./etc.)
      const trimUpper = text.trim().toUpperCase();
      if (NAME_PREFIXES.some(p => trimUpper.startsWith(p))) {
        colSignals[colIdx].name++;
      }

      // Phone signal
      if (PHONE_REGEX.test(text)) {
        colSignals[colIdx].phone++;
        PHONE_REGEX.lastIndex = 0;
      }
    }
  }

  // Build mapping from signals
  const fieldMap = {};
  const assigned = new Set();

  // Assign columns by strongest signal
  const fieldOrder = ['email', 'company', 'name', 'phone', 'city'];
  const fieldToKey = { email: 'email', company: 'company_name', name: 'contact_name', phone: 'phone', city: 'city' };

  for (const field of fieldOrder) {
    let bestCol = -1;
    let bestCount = 0;

    for (const [colIdx, signals] of Object.entries(colSignals)) {
      if (assigned.has(parseInt(colIdx))) continue;
      if (signals[field] > bestCount) {
        bestCount = signals[field];
        bestCol = parseInt(colIdx);
      }
    }

    if (bestCol >= 0 && bestCount >= 2) {
      fieldMap[bestCol] = fieldToKey[field];
      assigned.add(bestCol);
    }
  }

  console.log(`[memberTableMiner] Content-based mapping: ${JSON.stringify(fieldMap)}`);

  // If we have at least email column, parse rows
  const hasEmail = Object.values(fieldMap).includes('email');
  if (!hasEmail) {
    console.log(`[memberTableMiner] No email column detected, skipping table`);
    return cards;
  }

  // Use the same header-mapping parser with our inferred map
  return parseWithHeaderMapping(tableRows, { headerRowIndex: -1, fieldMap });
}

// ──────────────────────────────────────────────
// Cell extraction helpers
// ──────────────────────────────────────────────

/**
 * Decode common HTML entities
 */
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Extract company name from cell (typically bold/uppercase first line)
 */
function extractCompanyFromCell(text, html) {
  // Try bold text first
  const boldMatch = html.match(/<(?:strong|b)[^>]*>([^<]+)<\/(?:strong|b)>/i);
  if (boldMatch) {
    return decodeHtmlEntities(boldMatch[1].trim());
  }

  // First line of text
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 0) {
    return lines[0];
  }

  return text.trim() || null;
}

/**
 * Extract address from company cell (lines after company name)
 */
function extractAddressFromCompanyCell(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    // Everything after the first line is likely address
    return lines.slice(1).join(', ');
  }
  return null;
}

/**
 * Extract emails from cell text and HTML
 */
function extractEmailsFromCell(text, html, emailsArray) {
  const sources = [text, html];
  for (const src of sources) {
    const matches = src.match(EMAIL_REGEX) || [];
    for (const email of matches) {
      const cleaned = email.toLowerCase().trim();
      if (!emailsArray.includes(cleaned)) {
        emailsArray.push(cleaned);
      }
    }
  }
}

/**
 * Extract phone number from text, removing common prefixes
 */
function extractPhoneFromText(text) {
  if (!text) return null;

  // Remove known prefixes
  const cleaned = text
    .replace(/ph\s*[:.]?\s*/gi, '')
    .replace(/tel\s*[:.]?\s*/gi, '')
    .replace(/fax\s*[:.]?\s*/gi, '')
    .replace(/mob\s*[:.]?\s*/gi, '')
    .replace(/mobile\s*[:.]?\s*/gi, '');

  const matches = cleaned.match(PHONE_REGEX);
  if (matches && matches.length > 0) {
    // Return first phone, cleaned
    return matches[0].replace(/[\s\-().]/g, '').trim() || null;
  }

  return null;
}

/**
 * Extract website URL from cell
 */
function extractWebsiteFromCell(text, html) {
  // Try href first
  const hrefMatch = html.match(/href=["'](https?:\/\/[^"']+)["']/i);
  if (hrefMatch) {
    return hrefMatch[1];
  }

  // Try text URL
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) {
    return urlMatch[0];
  }

  // Try www.
  const wwwMatch = text.match(/www\.[^\s]+/i);
  if (wwwMatch) {
    return 'http://' + wwwMatch[0];
  }

  return null;
}

module.exports = { runMemberTableMiner };
