/**
 * inlineContactMiner.js — Extracts contacts directly from page HTML content.
 *
 * For pages where all contact info (emails, phones, company names) appears
 * inline on a single page — no exhibitor links to follow.
 *
 * Example: WordPress tables with firm listings, association member directories,
 * simple HTML pages with multiple company contacts listed.
 *
 * Input: Playwright page object + URL
 * Output: Array of raw contact cards
 */

const cheerio = require('cheerio');

// ============================================================
// NON-PERSON EMAIL PREFIXES (filter these out)
// ============================================================
const NON_PERSON_PREFIXES = [
  'mailer-daemon', 'postmaster', 'no-reply', 'noreply', 'donotreply',
  'bounce', 'unsubscribe', 'abuse', 'root', 'webmaster',
];

// ============================================================
// MULTI-LANGUAGE LABELS for context extraction
// ============================================================
const LABELS = {
  company: [
    'company', 'organization', 'organisation', 'firm',
    'firma', 'şirket', 'kuruluş',
    'société', 'entreprise',
    'unternehmen',
    'empresa', 'compañía',
    'firma adı', 'company name',
  ],
  contact_name: [
    'contact', 'contact person', 'name', 'person',
    'yetkili', 'yetkili kişi', 'kişi', 'isim', 'ad soyad', 'temsilci',
    'nom', 'personne',
    'kontakt', 'ansprechpartner',
    'contacto', 'nombre',
  ],
  phone: [
    'phone', 'tel', 'telephone', 'mobile', 'gsm', 'fax',
    'telefon', 'cep', 'faks',
    'téléphone', 'tél', 'portable',
    'telefon', 'mobil',
    'teléfono', 'móvil',
  ],
  website: [
    'website', 'web', 'url', 'homepage', 'site', 'www',
    'web sitesi', 'internet',
    'site web', 'site internet',
    'webseite', 'internetseite',
    'sitio web', 'página web',
  ],
  address: [
    'address', 'addr', 'location',
    'adres', 'adress',
    'adresse',
    'dirección',
  ],
  country: [
    'country', 'nation',
    'ülke',
    'pays',
    'land',
    'país',
  ],
  city: [
    'city', 'town',
    'şehir', 'il', 'ilçe',
    'ville',
    'stadt',
    'ciudad',
  ],
};

// ============================================================
// EMAIL REGEX
// ============================================================
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// ============================================================
// PHONE REGEX (international patterns)
// ============================================================
const PHONE_RE = /(?:\+?\d{1,4}[\s\-.]?)?\(?\d{1,5}\)?[\s\-.]?\d{2,5}[\s\-.]?\d{2,5}(?:[\s\-.]?\d{2,5})?/g;

// ============================================================
// URL REGEX (for website extraction)
// ============================================================
const URL_RE = /(?:https?:\/\/|www\.)[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi;

// ============================================================
// TITLE PREFIXES (person name indicators)
// ============================================================
const TITLE_PREFIXES = /^(mr\.?|mrs\.?|ms\.?|dr\.?|prof\.?|ing\.?|bay|bayan|sayın)\s+/i;

/**
 * Main entry point — accepts raw HTML (no Playwright navigation needed).
 *
 * This miner does NOT navigate — it receives pre-fetched HTML from the
 * orchestrator wrapper (via HtmlCache or prior miner's page.content()).
 * This avoids duplicate HTTP requests that trigger site-level blocking.
 *
 * @param {string} html - Pre-fetched HTML content
 * @param {string} url - Source URL (for source_url field in results)
 * @param {object} config - Optional config
 * @returns {Array<object>} Array of raw contact cards
 */
async function runInlineContactMiner(html, url, config = {}) {
  if (!html || html.length < 100) {
    console.log('[inlineContactMiner] No HTML content provided or too short');
    return [];
  }

  const $ = cheerio.load(html);

  // 3) Extract all emails from page
  const emailLocations = extractEmailLocations($);

  if (emailLocations.length === 0) {
    console.log('[inlineContactMiner] No emails found on page');
    return [];
  }

  console.log(`[inlineContactMiner] Found ${emailLocations.length} email locations`);

  // 4) For each email, extract context from surrounding DOM
  const cardMap = new Map(); // email → card (dedup/merge)

  for (const loc of emailLocations) {
    const card = extractCardFromContext($, loc);
    if (!card || !card.email) continue;

    const key = card.email.toLowerCase();

    // Filter non-person emails
    const prefix = key.split('@')[0];
    if (NON_PERSON_PREFIXES.some(np => prefix === np)) continue;

    // Merge: keep the richest data
    if (cardMap.has(key)) {
      const existing = cardMap.get(key);
      mergeCard(existing, card);
    } else {
      card.source_url = url;
      cardMap.set(key, card);
    }
  }

  const results = Array.from(cardMap.values());
  console.log(`[inlineContactMiner] Extracted ${results.length} unique contacts`);
  return results;
}

// ============================================================
// extractEmailLocations — find all emails and their DOM context
// ============================================================
function extractEmailLocations($) {
  const locations = [];

  // Method 1: mailto: links
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const emailMatch = href.replace('mailto:', '').split('?')[0].trim();
    if (emailMatch && emailMatch.includes('@')) {
      locations.push({
        email: emailMatch.toLowerCase(),
        element: el,
        method: 'mailto',
      });
    }
  });

  // Method 2: text content scan — find emails in text nodes
  // Walk through block-level containers
  const containers = $('td, th, li, p, div, span, dd, dt, address');
  containers.each((_, el) => {
    const text = $(el).clone().children().remove().end().text(); // direct text only
    const matches = text.match(EMAIL_RE);
    if (matches) {
      for (const m of matches) {
        // Avoid duplicates from mailto
        const already = locations.some(
          l => l.email === m.toLowerCase() && l.element === el
        );
        if (!already) {
          locations.push({
            email: m.toLowerCase(),
            element: el,
            method: 'text',
          });
        }
      }
    }
  });

  return locations;
}

// ============================================================
// extractCardFromContext — build a contact card from surrounding DOM
// ============================================================
function extractCardFromContext($, loc) {
  const { email, element } = loc;

  // Find the best container: walk up from the element to find a meaningful block
  const container = findContainer($, element);
  if (!container) {
    return { email, company_name: domainToCompany(email) };
  }

  const containerHtml = $(container).html() || '';
  // Convert <br> to newlines before extracting text (cheerio .text() doesn't)
  const containerText = $(container).html()
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|tr|td|th|dt|dd)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/  +/g, ' ')
    .trim();

  // Parse labeled fields from the container text
  const fields = parseLabeledFields(containerText);

  // Try extracting from table row structure
  const tableFields = parseTableRowContext($, element);

  // Build card
  const card = {
    email,
    company_name: fields.company || tableFields.company || findBoldText($, container) || domainToCompany(email),
    contact_name: fields.contact_name || tableFields.contact_name || findTitlePrefixName(containerText) || null,
    phone: fields.phone || tableFields.phone || findPhone(containerText) || null,
    website: fields.website || tableFields.website || findWebsite(containerText, containerHtml) || null,
    country: fields.country || tableFields.country || null,
    city: fields.city || tableFields.city || null,
    address: fields.address || tableFields.address || null,
    job_title: null,
  };

  return card;
}

// ============================================================
// findContainer — walk up DOM to find a meaningful container
// ============================================================
function findContainer($, element) {
  let current = element;

  for (let i = 0; i < 6; i++) {
    const parent = $(current).parent();
    if (!parent || parent.length === 0) break;

    const tag = (parent.prop('tagName') || '').toLowerCase();

    // Good containers: table rows, list items, divs with siblings, definition lists
    if (tag === 'tr') return parent[0];
    if (tag === 'li') return parent[0];
    if (tag === 'dl') return parent[0];
    if (tag === 'article') return parent[0];
    if (tag === 'section') return parent[0];

    // A div/td with enough text content is a good container
    if ((tag === 'div' || tag === 'td') && (parent.text() || '').length > 30) {
      return parent[0];
    }

    current = parent[0];
  }

  // Fallback: return the closest block-level ancestor
  return $(element).closest('tr, li, div, td, dd, article, section')[0] || null;
}

// ============================================================
// parseLabeledFields — extract "Label: Value" patterns from text
// ============================================================
function parseLabeledFields(text) {
  const result = {};
  const lines = text.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    // Match "Label: Value" or "Label - Value" patterns
    const match = line.match(/^([^:–\-]+?)\s*[:–\-]\s*(.+)/);
    if (!match) continue;

    const label = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (!value || value.length < 2) continue;

    for (const [field, keywords] of Object.entries(LABELS)) {
      if (keywords.some(kw => label.includes(kw))) {
        if (field === 'company' && !result.company) {
          result.company = value;
        } else if (field === 'contact_name' && !result.contact_name) {
          result.contact_name = value;
        } else if (field === 'phone' && !result.phone) {
          result.phone = value;
        } else if (field === 'website' && !result.website) {
          result.website = value;
        } else if (field === 'address' && !result.address) {
          result.address = value;
        } else if (field === 'country' && !result.country) {
          result.country = value;
        } else if (field === 'city' && !result.city) {
          result.city = value;
        }
        break;
      }
    }
  }

  return result;
}

// ============================================================
// parseTableRowContext — if email is in a table, extract from row cells
// ============================================================
function parseTableRowContext($, element) {
  const result = {};
  const row = $(element).closest('tr');
  if (!row.length) return result;

  // Get all cells in this row
  const cells = row.find('td, th');
  const cellTexts = [];
  cells.each((_, c) => cellTexts.push($(c).text().trim()));

  // Try to find header row for column mapping
  const table = row.closest('table');
  const headerRow = table.find('tr').first();
  const headers = [];
  headerRow.find('td, th').each((_, c) => headers.push($(c).text().trim().toLowerCase()));

  if (headers.length === cellTexts.length && headers.length > 1) {
    // Map headers to fields
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      const v = cellTexts[i];
      if (!v) continue;

      for (const [field, keywords] of Object.entries(LABELS)) {
        if (keywords.some(kw => h.includes(kw))) {
          if (field === 'company') result.company = v;
          else if (field === 'contact_name') result.contact_name = v;
          else if (field === 'phone') result.phone = v;
          else if (field === 'website') result.website = v;
          else if (field === 'address') result.address = v;
          else if (field === 'country') result.country = v;
          else if (field === 'city') result.city = v;
          break;
        }
      }
    }
  }

  return result;
}

// ============================================================
// Helper: find bold/strong text in container (likely company name)
// ============================================================
function findBoldText($, container) {
  const bold = $(container).find('b, strong, h1, h2, h3, h4, h5, h6').first();
  if (bold.length) {
    const text = bold.text().trim();
    // Only use if reasonable length and doesn't look like a label
    if (text.length >= 3 && text.length <= 120 && !text.includes(':')) {
      return text;
    }
  }
  return null;
}

// ============================================================
// Helper: find person name by title prefix (Mr., Mrs., Dr., etc.)
// ============================================================
function findTitlePrefixName(text) {
  const lines = text.split(/[\n\r,;]+/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (TITLE_PREFIXES.test(trimmed) && trimmed.length <= 60) {
      return trimmed;
    }
  }
  return null;
}

// ============================================================
// Helper: find phone number in text
// ============================================================
function findPhone(text) {
  // Remove emails first to avoid matching email parts
  const cleaned = text.replace(EMAIL_RE, ' ');
  const matches = cleaned.match(PHONE_RE);
  if (matches) {
    // Return the first match that looks like a real phone (7+ digits)
    for (const m of matches) {
      const digits = m.replace(/\D/g, '');
      if (digits.length >= 7 && digits.length <= 15) {
        return m.trim();
      }
    }
  }
  return null;
}

// ============================================================
// Helper: find website URL in text/html
// ============================================================
function findWebsite(text, html) {
  // Try from text first
  const textMatches = text.match(URL_RE);
  if (textMatches) {
    for (const m of textMatches) {
      // Skip if it's a social media or email-related URL
      if (!m.includes('mailto:') && !m.includes('javascript:')) {
        return m;
      }
    }
  }

  // Try from href attributes in HTML
  const hrefMatch = html.match(/href=["'](https?:\/\/[^"']+)["']/i);
  if (hrefMatch && !hrefMatch[1].includes('mailto:')) {
    return hrefMatch[1];
  }

  return null;
}

// ============================================================
// Helper: guess company name from email domain
// ============================================================
function domainToCompany(email) {
  if (!email || !email.includes('@')) return null;
  const domain = email.split('@')[1];
  if (!domain) return null;

  // Skip generic domains
  const generic = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
    'mail.ru', 'yandex.ru', 'qq.com', '163.com', '126.com', 'aol.com',
    'protonmail.com', 'icloud.com', 'live.com', 'msn.com'];
  if (generic.includes(domain.toLowerCase())) return null;

  // Take domain name part (before TLD)
  const parts = domain.split('.');
  if (parts.length >= 2) {
    return parts[0]; // e.g., info@katicapekseg.hu → katicapekseg
  }
  return null;
}

// ============================================================
// Helper: merge two cards (keep richest data)
// ============================================================
function mergeCard(existing, incoming) {
  for (const key of Object.keys(incoming)) {
    if (key === 'email' || key === 'source_url') continue;
    if (incoming[key] && !existing[key]) {
      existing[key] = incoming[key];
    }
    // Prefer longer values (more detail)
    if (incoming[key] && existing[key] &&
        String(incoming[key]).length > String(existing[key]).length) {
      existing[key] = incoming[key];
    }
  }
}

module.exports = { runInlineContactMiner };
