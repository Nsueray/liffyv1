/**
 * signatureParser.js — Extract contact info from email reply signatures.
 *
 * Best-effort extraction. Returns null if nothing useful found.
 * Used by webhooks.js inbound handler to enrich persons/affiliations.
 */

const db = require('../db');

// Common signature separators
const SEPARATOR_PATTERNS = [
  /^--\s*$/m,                          // "-- " (standard sig separator)
  /^_{3,}$/m,                          // "___" underscores
  /^-{3,}$/m,                          // "---" dashes
  /^={3,}$/m,                          // "===" equals
];

// Closing phrases — signature typically follows these
const CLOSING_RE = /^(?:regards|best regards|kind regards|best|thanks|thank you|cheers|sincerely|with regards|warm regards|cordially|respectfully|yours truly|saygılarımla|selamlar|teşekkürler|iyi dileklerimle|mit freundlichen grüßen|cordialement|atentamente|saludos)\s*[,.]?\s*$/im;

// Phone regex — international formats
const PHONE_RE = /(?:\+?\d{1,4}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{2,4}[\s.-]?\d{2,4}(?:[\s.-]?\d{1,4})?/g;

// Job title keywords
const TITLE_KEYWORDS = [
  'CEO', 'CTO', 'CFO', 'COO', 'CIO', 'CMO',
  'VP', 'Vice President',
  'President', 'Founder', 'Co-Founder', 'Owner', 'Partner',
  'Director', 'Managing Director',
  'Head of', 'Chief',
  'Manager', 'General Manager', 'Regional Manager', 'Area Manager',
  'Sales Manager', 'Marketing Manager', 'Project Manager', 'Account Manager',
  'Supervisor', 'Coordinator', 'Specialist', 'Consultant',
  'Engineer', 'Architect', 'Analyst', 'Developer',
  'Representative', 'Executive', 'Officer',
  'Müdür', 'Genel Müdür', 'Satış Müdürü', 'Pazarlama Müdürü',
  'Direktör', 'Koordinatör', 'Uzman', 'Mühendis',
  'Geschäftsführer', 'Leiter', 'Vertrieb',
  'Directeur', 'Responsable', 'Gérant',
];

// Build title regex from keywords — match within a single line only
const TITLE_RE = new RegExp(
  `\\b(?:${TITLE_KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b[\\w /&-]{0,40}`,
  'im'
);

// Website pattern
const WEBSITE_RE = /(?:www\.|https?:\/\/)[\w.-]+\.\w{2,}(?:\/[\w./-]*)?/i;

/**
 * Extract signature block from the bottom of an email body.
 * Returns the lines most likely to be part of a signature.
 */
function extractSignatureBlock(body) {
  if (!body || typeof body !== 'string') return null;

  // Strip HTML tags if present
  let text = body.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();

  // Remove quoted reply content (lines starting with >)
  text = text.split('\n').filter(l => !l.trimStart().startsWith('>')).join('\n');

  if (!text) return null;

  const lines = text.split('\n');

  // Strategy 1: Find explicit separator
  for (const sep of SEPARATOR_PATTERNS) {
    const idx = text.search(sep);
    if (idx !== -1) {
      const after = text.substring(idx).split('\n').slice(1);
      if (after.length > 0 && after.length <= 20) {
        return after.join('\n').trim();
      }
    }
  }

  // Strategy 2: Find closing phrase
  for (let i = 0; i < lines.length; i++) {
    if (CLOSING_RE.test(lines[i])) {
      const after = lines.slice(i + 1);
      if (after.length > 0 && after.length <= 20) {
        return after.join('\n').trim();
      }
    }
  }

  // Strategy 3: Last 10 non-empty lines (fallback for short emails)
  const nonEmpty = lines.filter(l => l.trim().length > 0);
  if (nonEmpty.length >= 3) {
    return nonEmpty.slice(-10).join('\n').trim();
  }

  return null;
}

/**
 * Parse structured data from a signature block.
 * @param {string} body - Full email body (text or HTML)
 * @returns {{ fullName: string|null, title: string|null, company: string|null, phone: string|null, website: string|null } | null}
 */
function parseEmailSignature(body) {
  const sigBlock = extractSignatureBlock(body);
  if (!sigBlock) return null;

  const result = {
    fullName: null,
    title: null,
    company: null,
    phone: null,
    website: null,
  };

  const lines = sigBlock.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return null;

  // Phone
  const allPhones = sigBlock.match(PHONE_RE);
  if (allPhones) {
    // Pick longest match (most likely the full phone number)
    const best = allPhones.sort((a, b) => b.length - a.length)[0].trim();
    // Validate: at least 7 digits
    if (best.replace(/\D/g, '').length >= 7) {
      result.phone = best;
    }
  }

  // Title
  const titleMatch = sigBlock.match(TITLE_RE);
  if (titleMatch) {
    result.title = titleMatch[0].trim();
  }

  // Website
  const webMatch = sigBlock.match(WEBSITE_RE);
  if (webMatch) {
    result.website = webMatch[0];
  }

  // Name: typically first non-empty line of the signature that isn't a title/phone/url
  for (const line of lines) {
    // Skip lines that are phone numbers, URLs, or email addresses
    if (PHONE_RE.test(line)) continue;
    if (WEBSITE_RE.test(line)) continue;
    if (/@/.test(line)) continue;
    // Skip very short or very long lines
    if (line.length < 3 || line.length > 50) continue;
    // Skip lines with too many special characters
    if (line.replace(/[a-zA-ZÀ-ÿĞğİıÖöÜüŞşÇç\s.'-]/g, '').length > 3) continue;
    // Skip lines that are just the title we already found
    if (result.title && line.toLowerCase().includes(result.title.toLowerCase())) continue;

    // This looks like a name
    result.fullName = line.replace(/[,.|]+$/, '').trim();
    break;
  }

  // Company: look for a line that's likely a company name (after the name line)
  const nameIdx = result.fullName ? lines.indexOf(result.fullName.replace(/[,.|]+$/, '').trim()) : -1;
  for (let i = (nameIdx >= 0 ? nameIdx + 1 : 0); i < lines.length; i++) {
    const line = lines[i];
    // Skip phone, URL, email, title lines
    if (PHONE_RE.test(line)) continue;
    if (WEBSITE_RE.test(line)) continue;
    if (/@/.test(line)) continue;
    if (result.title && line.toLowerCase() === result.title.toLowerCase()) continue;
    if (result.fullName && line === result.fullName) continue;
    if (line.length < 2 || line.length > 80) continue;

    // If this line contains a title keyword, it's likely "Title at Company" or just title
    const titleInLine = TITLE_RE.test(line);
    if (titleInLine) {
      // Try to extract company from "Title at Company" or "Title, Company"
      const atSplit = line.split(/\s+(?:at|@|\/|,|-|–|—)\s+/i);
      if (atSplit.length > 1) {
        result.company = atSplit[atSplit.length - 1].trim();
      }
      continue;
    }

    // Looks like a company name
    result.company = line.replace(/[,.|]+$/, '').trim();
    break;
  }

  // Return null if nothing useful found
  const hasData = result.fullName || result.title || result.company || result.phone;
  return hasData ? result : null;
}

/**
 * Enrich person and affiliation from parsed signature data.
 * Only fills EMPTY fields — never overwrites existing data.
 *
 * @param {string} personId - UUID of the person
 * @param {string} organizerId - UUID of the organizer
 * @param {object} signatureData - Output of parseEmailSignature()
 */
async function enrichPersonFromSignature(personId, organizerId, signatureData) {
  if (!personId || !signatureData) return;

  try {
    // Load current person data
    const personRes = await db.query(
      'SELECT id, first_name, last_name, phone FROM persons WHERE id = $1 AND organizer_id = $2',
      [personId, organizerId]
    );
    if (personRes.rows.length === 0) return;

    const person = personRes.rows[0];
    const enriched = [];

    // Person updates — only fill empty fields
    const personUpdates = [];
    const personParams = [];
    let pIdx = 1;

    if (!person.phone && signatureData.phone) {
      personUpdates.push(`phone = $${pIdx++}`);
      personParams.push(signatureData.phone);
      enriched.push('phone');
    }

    if (!person.first_name && signatureData.fullName) {
      const parts = signatureData.fullName.split(/\s+/);
      personUpdates.push(`first_name = $${pIdx++}`);
      personParams.push(parts[0]);
      enriched.push('first_name');

      if (!person.last_name && parts.length > 1) {
        personUpdates.push(`last_name = $${pIdx++}`);
        personParams.push(parts.slice(1).join(' '));
        enriched.push('last_name');
      }
    }

    if (personUpdates.length > 0) {
      personParams.push(personId, organizerId);
      await db.query(
        `UPDATE persons SET ${personUpdates.join(', ')} WHERE id = $${pIdx++} AND organizer_id = $${pIdx}`,
        personParams
      );
    }

    // Affiliation updates — update most recent affiliation
    if (signatureData.title || signatureData.company) {
      const affRes = await db.query(
        `SELECT id, position, company_name FROM affiliations
         WHERE person_id = $1 AND organizer_id = $2
         ORDER BY created_at DESC LIMIT 1`,
        [personId, organizerId]
      );

      if (affRes.rows.length > 0) {
        const aff = affRes.rows[0];
        const affUpdates = [];
        const affParams = [];
        let aIdx = 1;

        if (!aff.position && signatureData.title) {
          affUpdates.push(`position = $${aIdx++}`);
          affParams.push(signatureData.title);
          enriched.push('position');
        }

        if (!aff.company_name && signatureData.company) {
          affUpdates.push(`company_name = $${aIdx++}`);
          affParams.push(signatureData.company);
          enriched.push('company_name');
        }

        if (affUpdates.length > 0) {
          affParams.push(aff.id);
          await db.query(
            `UPDATE affiliations SET ${affUpdates.join(', ')} WHERE id = $${aIdx}`,
            affParams
          );
        }
      }
    }

    // Log enrichment as contact activity
    if (enriched.length > 0) {
      await db.query(
        `INSERT INTO contact_activities
           (organizer_id, person_id, activity_type, description, meta)
         VALUES ($1, $2, 'auto_enrichment', $3, $4)`,
        [
          organizerId,
          personId,
          `Auto-enriched from reply signature: ${enriched.join(', ')}`,
          JSON.stringify({ source: 'reply_signature', fields: enriched, data: signatureData }),
        ]
      );

      console.log(`  🔍 Signature enrichment: person ${personId} — ${enriched.join(', ')}`);
    }
  } catch (err) {
    // Best effort — never fail the reply processing
    console.warn(`  ⚠️ Signature enrichment failed for person ${personId}:`, err.message);
  }
}

module.exports = { parseEmailSignature, enrichPersonFromSignature };
