/**
 * LIFFY Label-Value Miner v1.0
 *
 * Extracts data from flat HTML directory listings where entries follow a
 * bold-label:value pattern separated by <br> tags.
 *
 * Target pattern:
 *   <b>CompanyName</b><br>
 *   Optional subtitle<br>
 *   <b>Address:</b> value<br>
 *   <b>Phone:</b> value<br>
 *   <b>Email:</b> <a href="mailto:xxx">xxx</a><br>
 *   <b>Website:</b> <a href="xxx">xxx</a><br>
 *   <br><br>  ← separator to next entry
 *
 * Returns raw card data — normalization handled by flowOrchestrator.
 *
 * Usage (module only — browser lifecycle managed by flowOrchestrator wrapper):
 *   const { runLabelValueMiner } = require("./labelValueMiner");
 *   const cards = await runLabelValueMiner(page, url, config);
 */

// ──────────────────────────────────────────────
// Label keywords (multi-language)
// ──────────────────────────────────────────────
const LABEL_KEYWORDS = {
  address: [
    'address', 'adresse', 'dirección', 'direccion', 'adres', 'indirizzo',
    'endereço', 'endereco', 'adresse postale', 'anschrift', 'alamat'
  ],
  phone: [
    'phone', 'tel', 'telephone', 'telefon', 'teléfono', 'telefono',
    'telefone', 'mob', 'mobile', 'fax', 'gsm'
  ],
  email: [
    'email', 'e-mail', 'mail', 'e mail', 'e-posta', 'eposta',
    'correo', 'courriel'
  ],
  website: [
    'website', 'web', 'web site', 'site web', 'sitio web', 'homepage',
    'internet', 'url', 'webpage'
  ]
};

// Build a flat set of all label keywords for quick lookup
const ALL_LABEL_WORDS = new Set();
for (const keywords of Object.values(LABEL_KEYWORDS)) {
  for (const kw of keywords) {
    ALL_LABEL_WORDS.add(kw);
  }
}

/**
 * Check if a bold text is a label (e.g. "Address:", "Phone:", "Email:")
 * Returns { isLabel: true, field: 'address' } or { isLabel: false }
 */
function classifyBold(text) {
  // Strip trailing colon and whitespace
  const cleaned = text.replace(/:\s*$/, '').trim().toLowerCase();

  for (const [field, keywords] of Object.entries(LABEL_KEYWORDS)) {
    for (const kw of keywords) {
      if (cleaned === kw || cleaned.startsWith(kw + '/') || cleaned.endsWith('/' + kw)) {
        return { isLabel: true, field };
      }
    }
  }

  // Check for compound labels like "Phone/Fax:", "Tel/Mobile:"
  const parts = cleaned.split(/[\/,&]+/).map(p => p.trim());
  for (const part of parts) {
    if (ALL_LABEL_WORDS.has(part)) {
      for (const [field, keywords] of Object.entries(LABEL_KEYWORDS)) {
        if (keywords.includes(part)) {
          return { isLabel: true, field };
        }
      }
    }
  }

  return { isLabel: false };
}

/**
 * Main mining function
 * @param {import('playwright').Page} page - Playwright Page object
 * @param {string} url - Target URL
 * @param {Object} config - Job config
 * @returns {Promise<Array>} Raw card array
 */
async function runLabelValueMiner(page, url, config = {}) {
  const waitMs = config.delay_ms || 1500;

  console.log(`[labelValueMiner] Starting: ${url}`);

  // Navigate
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(waitMs);

  // Extract entries via page.evaluate
  const rawEntries = await page.evaluate(() => {
    // Find the content container: the smallest element that contains all "Address:" labels
    const allElements = Array.from(document.querySelectorAll('*'));
    const containers = allElements.filter(el => {
      const text = el.innerText || '';
      const addressCount = (text.match(/\bAddress\b|\bAdresse\b|\bDirección\b|\bAdres\b/gi) || []).length;
      return addressCount >= 2;
    });

    if (containers.length === 0) return [];

    // Get the smallest qualifying container
    containers.sort((a, b) => a.innerHTML.length - b.innerHTML.length);
    const container = containers[0];

    // Get all <b>/<strong> elements in the container
    const boldElements = Array.from(container.querySelectorAll('b, strong'));
    if (boldElements.length === 0) return [];

    // Known label patterns (checked client-side for speed)
    const LABEL_PATTERNS = /^(address|adresse|dirección|direccion|adres|indirizzo|endereço|endereco|phone|tel|telephone|telefon|teléfono|telefono|telefone|mob|mobile|fax|gsm|email|e-mail|mail|e mail|e-posta|eposta|correo|courriel|website|web|web site|site web|sitio web|homepage|internet|url|webpage)(\s*\/\s*(phone|tel|telephone|telefon|fax|mobile|gsm|mob))?\s*:?\s*$/i;

    const entries = [];
    let currentEntry = null;

    for (const bold of boldElements) {
      const text = bold.textContent.trim();
      if (!text || text.length > 200) continue;

      const cleanedForLabel = text.replace(/:\s*$/, '').trim();
      const isLabel = LABEL_PATTERNS.test(cleanedForLabel);

      if (!isLabel) {
        // This is a company name — start new entry
        if (currentEntry && currentEntry.company_name) {
          entries.push(currentEntry);
        }
        currentEntry = { company_name: text, address: null, phone: null, email: null, website: null };

        // Check if there's a subtitle (next sibling text node before the next bold)
        // Skip — raw data, normalizer can handle
      } else if (currentEntry) {
        // This is a label — extract value from siblings/next nodes
        const labelLower = cleanedForLabel.toLowerCase();

        // Determine field type
        let field = null;
        if (/address|adresse|dirección|direccion|adres|indirizzo|endereço|endereco/i.test(labelLower)) field = 'address';
        else if (/phone|tel|telephone|telefon|teléfono|telefono|telefone|mob|mobile|fax|gsm/i.test(labelLower)) field = 'phone';
        else if (/email|e-mail|mail|e.mail|e-posta|eposta|correo|courriel/i.test(labelLower)) field = 'email';
        else if (/website|web|site web|sitio web|homepage|internet|url|webpage/i.test(labelLower)) field = 'website';

        if (!field) continue;

        if (field === 'email') {
          // Search immediate siblings after the bold for mailto: link or email text
          let emailFound = null;
          let node = bold.nextSibling;
          let nodeCount = 0;
          while (node && nodeCount < 10) {
            if (node.nodeType === 1) { // Element node
              if (node.tagName === 'B' || node.tagName === 'STRONG') break; // next label — stop
              if (node.tagName === 'BR') { nodeCount++; node = node.nextSibling; continue; }
              if (node.tagName === 'A') {
                const href = node.getAttribute('href') || '';
                if (href.startsWith('mailto:')) {
                  const email = href.replace('mailto:', '').trim();
                  if (email && email.includes('@')) emailFound = email;
                }
                // Also check link text
                if (!emailFound) {
                  const linkText = node.textContent.trim();
                  const emailMatch = linkText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
                  if (emailMatch) emailFound = emailMatch[0];
                }
                break; // Found the <a> after Email: label — stop regardless
              }
            } else if (node.nodeType === 3) { // Text node
              const text = node.textContent.trim();
              const emailMatch = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
              if (emailMatch) { emailFound = emailMatch[0]; break; }
            }
            node = node.nextSibling;
            nodeCount++;
          }
          currentEntry.email = emailFound;
        } else if (field === 'website') {
          // Look for <a> link in siblings
          let sibling = bold.nextElementSibling;
          let websiteFound = null;
          let searchCount = 0;
          while (sibling && searchCount < 5) {
            if (sibling.tagName === 'A') {
              const href = sibling.getAttribute('href') || '';
              if (href.startsWith('http') && !href.includes('mailto:')) {
                websiteFound = href;
                break;
              }
            }
            if (sibling.tagName === 'B' || sibling.tagName === 'STRONG') break;
            sibling = sibling.nextElementSibling;
            searchCount++;
          }

          // Fallback: text after bold
          if (!websiteFound) {
            let textAfter = '';
            let node = bold.nextSibling;
            let nodeCount = 0;
            while (node && nodeCount < 10) {
              if (node.nodeType === 3) textAfter += node.textContent;
              else if (node.tagName === 'A') {
                const href = node.getAttribute('href') || '';
                if (href.startsWith('http')) { websiteFound = href; break; }
                textAfter += node.textContent;
              }
              else if (node.tagName === 'B' || node.tagName === 'STRONG' || node.tagName === 'BR') break;
              node = node.nextSibling;
              nodeCount++;
            }
            if (!websiteFound) {
              const urlMatch = textAfter.match(/https?:\/\/[^\s]+|www\.[^\s]+/i);
              if (urlMatch) websiteFound = urlMatch[0].startsWith('www') ? 'http://' + urlMatch[0] : urlMatch[0];
            }
          }

          currentEntry.website = websiteFound;
        } else {
          // address or phone: extract text content after the bold
          let textAfter = '';
          let node = bold.nextSibling;
          let nodeCount = 0;
          while (node && nodeCount < 15) {
            if (node.nodeType === 3) {
              textAfter += node.textContent;
            } else if (node.tagName === 'BR') {
              break;
            } else if (node.tagName === 'B' || node.tagName === 'STRONG') {
              break;
            } else {
              textAfter += node.textContent || '';
            }
            node = node.nextSibling;
            nodeCount++;
          }

          const value = textAfter.replace(/;\s*$/, '').trim();
          if (value && value.length > 1) {
            if (field === 'phone') {
              // May contain "Phone: xxx; Fax: yyy" — store raw, normalizer handles
              currentEntry.phone = value;
            } else {
              currentEntry[field] = value;
            }
          }
        }
      }
    }

    // Don't forget the last entry
    if (currentEntry && currentEntry.company_name) {
      entries.push(currentEntry);
    }

    return entries;
  });

  console.log(`[labelValueMiner] Extracted ${rawEntries.length} entries`);

  // Convert to standard card format
  const cards = rawEntries.map(entry => ({
    company_name: entry.company_name || null,
    email: entry.email || null,
    phone: entry.phone || null,
    website: entry.website || null,
    address: entry.address || null,
    contact_name: null,
    job_title: null,
    country: null,
    city: null
  }));

  console.log(`[labelValueMiner] Result: ${cards.length} cards, ${cards.filter(c => c.email).length} with email`);

  return cards;
}

module.exports = { runLabelValueMiner };
