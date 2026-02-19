/**
 * Template Processor — shared by campaignSend.js, worker.js, emailTemplates.js
 *
 * Supported placeholders:
 * {{first_name}}, {{last_name}}, {{name}}, {{display_name}},
 * {{company_name}}, {{company}}, {{email}}, {{country}},
 * {{position}}, {{website}}, {{tag}}, {{unsubscribe_url}}
 *
 * Pipe fallback syntax:
 * {{field1|field2|"literal"}} — tries each in order, uses first non-empty value
 */

/**
 * Process template placeholders with recipient data.
 *
 * @param {string} text - Template text (subject, body_html, or body_text)
 * @param {object} recipient - Recipient object with .name, .email, .meta (JSONB)
 * @param {object} extras - Additional values like { unsubscribe_url }
 * @returns {string} Processed text with placeholders replaced
 */
function processTemplate(text, recipient, extras = {}) {
  if (!text) return "";

  // Parse meta (JSONB — may be string or object)
  let meta = {};
  if (recipient.meta) {
    try {
      meta = typeof recipient.meta === 'string'
        ? JSON.parse(recipient.meta)
        : recipient.meta;
    } catch (e) {
      meta = {};
    }
  }

  // Canonical first_name/last_name preferred, name split as fallback
  const fullName = recipient.name || "";
  let firstName = meta.first_name || "";
  let lastName = meta.last_name || "";
  if (!firstName && fullName) {
    const nameParts = fullName.trim().split(/\s+/);
    firstName = nameParts[0] || "";
    lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : "";
  }

  const companyName = meta.company || meta.company_name || "";
  const country = meta.country || "";
  const position = meta.position || meta.job_title || meta.title || "";
  const website = meta.website || "";
  const tag = Array.isArray(meta.tags) ? (meta.tags[0] || "") : (meta.tag || "");
  const email = recipient.email || "";

  // Computed: display_name (first_name → company_name → "Valued Partner")
  const displayName = firstName || companyName || "Valued Partner";

  // Field lookup map for pipe fallback syntax
  const fields = {
    first_name: firstName,
    last_name: lastName,
    name: fullName,
    company_name: companyName,
    company: companyName,
    display_name: displayName,
    email,
    country,
    position,
    website,
    tag
  };

  let processed = text;

  // Step 1: Pipe fallback syntax — {{field1|field2|"literal"}}
  processed = processed.replace(/\{\{([^}]*\|[^}]*)\}\}/gi, (match, inner) => {
    const segments = inner.split('|');
    for (const seg of segments) {
      const trimmed = seg.trim();
      // Quoted literal: "text" or 'text'
      const literalMatch = trimmed.match(/^["'](.*)["']$/);
      if (literalMatch) {
        return literalMatch[1];
      }
      // Field lookup
      const val = fields[trimmed.toLowerCase()];
      if (val) return val;
    }
    return "";
  });

  // Step 2: Simple placeholders (case insensitive)
  processed = processed.replace(/\{\{first_name\}\}/gi, firstName);
  processed = processed.replace(/\{\{last_name\}\}/gi, lastName);
  processed = processed.replace(/\{\{name\}\}/gi, fullName);
  processed = processed.replace(/\{\{display_name\}\}/gi, displayName);
  processed = processed.replace(/\{\{company_name\}\}/gi, companyName);
  processed = processed.replace(/\{\{company\}\}/gi, companyName);
  processed = processed.replace(/\{\{email\}\}/gi, email);
  processed = processed.replace(/\{\{country\}\}/gi, country);
  processed = processed.replace(/\{\{position\}\}/gi, position);
  processed = processed.replace(/\{\{website\}\}/gi, website);
  processed = processed.replace(/\{\{tag\}\}/gi, tag);

  // Unsubscribe
  if (extras.unsubscribe_url) {
    processed = processed.replace(/\{\{unsubscribe_url\}\}/gi, extras.unsubscribe_url);
    processed = processed.replace(/\{\{unsubscribe_link\}\}/gi, extras.unsubscribe_url);
  }

  return processed;
}

/**
 * Plain text → HTML auto-converter.
 * If body_html has no HTML tags, wraps plain text in styled paragraphs.
 * If already HTML, returns unchanged.
 */
function convertPlainTextToHtml(text) {
  if (!text || !text.trim()) return text;

  // Check for HTML tags (excluding placeholders)
  const withoutPlaceholders = text.replace(/\{\{[^}]+\}\}/g, '');
  if (/<[a-z][\s\S]*?>/i.test(withoutPlaceholders)) {
    return text;
  }

  // Plain text → HTML: paragraphs + line breaks
  const paragraphs = text.split(/\n\s*\n/).map(p => {
    const lines = p.trim().replace(/\n/g, '<br>');
    return `<p>${lines}</p>`;
  });

  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#333">${paragraphs.join('')}</div>`;
}

module.exports = { processTemplate, convertPlainTextToHtml };
