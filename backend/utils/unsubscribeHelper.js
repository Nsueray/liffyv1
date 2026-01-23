/**
 * LIFFY Unsubscribe Helper Utility
 * ================================
 * Single source of truth for all unsubscribe operations.
 * Used by: worker.js, campaignSend.js, mailer.js
 * 
 * Architecture: Stealth Compliance (v2.1)
 * - Legal compliance without marketing appearance
 * - Natural language footers
 * - RFC 8058 List-Unsubscribe headers
 */

const crypto = require('crypto');

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  // Token expiry: 90 days
  TOKEN_EXPIRY_MS: 90 * 24 * 60 * 60 * 1000,
  
  // Base URL for unsubscribe endpoints
  BASE_URL: process.env.API_BASE_URL || 'https://api.liffy.app',
  
  // Secret for HMAC signing
  getSecret: () => process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET || 'liffy_unsub_secret'
};

// ============================================================
// TOKEN GENERATION & VERIFICATION
// ============================================================

/**
 * Generate unsubscribe token
 * Token format: base64url(email:organizer_id:timestamp:signature)
 * 
 * @param {string} email - Recipient email
 * @param {number|string} organizerId - Organizer ID
 * @returns {string} - Base64url encoded token
 */
function generateUnsubscribeToken(email, organizerId) {
  const secret = CONFIG.getSecret();
  const timestamp = Date.now();
  const data = `${email}:${organizerId}:${timestamp}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('hex')
    .substring(0, 16);
  
  return Buffer.from(`${data}:${signature}`).toString('base64url');
}

/**
 * Verify and decode unsubscribe token
 * 
 * @param {string} token - Base64url encoded token
 * @returns {object|null} - { email, organizerId } or null if invalid
 */
function verifyUnsubscribeToken(token) {
  try {
    const secret = CONFIG.getSecret();
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split(':');
    
    if (parts.length !== 4) {
      return null;
    }

    const [email, organizerId, timestamp, signature] = parts;
    const data = `${email}:${organizerId}:${timestamp}`;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(data)
      .digest('hex')
      .substring(0, 16);

    if (signature !== expectedSignature) {
      return null;
    }

    // Check token expiry
    const tokenAge = Date.now() - parseInt(timestamp);
    if (tokenAge > CONFIG.TOKEN_EXPIRY_MS) {
      return null;
    }

    return { email, organizerId };
  } catch (err) {
    return null;
  }
}

// ============================================================
// URL GENERATION
// ============================================================

/**
 * Generate full unsubscribe URL for email templates
 * 
 * @param {string} email - Recipient email
 * @param {number|string} organizerId - Organizer ID
 * @returns {string} - Full unsubscribe URL
 */
function getUnsubscribeUrl(email, organizerId) {
  const token = generateUnsubscribeToken(email, organizerId);
  return `${CONFIG.BASE_URL}/api/unsubscribe/${token}`;
}

/**
 * Generate mailto unsubscribe URL (for List-Unsubscribe header)
 * 
 * @param {string} fromEmail - Sender email address
 * @returns {string} - Mailto URL
 */
function getUnsubscribeMailto(fromEmail) {
  const replyAddress = fromEmail || 'unsubscribe@liffy.app';
  return `mailto:${replyAddress}?subject=Unsubscribe`;
}

// ============================================================
// LIST-UNSUBSCRIBE HEADERS (RFC 8058)
// ============================================================

/**
 * Generate List-Unsubscribe headers for SendGrid
 * These headers enable one-click unsubscribe in Gmail/Outlook
 * 
 * @param {string} email - Recipient email
 * @param {number|string} organizerId - Organizer ID
 * @param {string} fromEmail - Sender email (for mailto fallback)
 * @returns {object} - Headers object for SendGrid
 */
function getListUnsubscribeHeaders(email, organizerId, fromEmail) {
  const unsubUrl = getUnsubscribeUrl(email, organizerId);
  const mailtoUrl = getUnsubscribeMailto(fromEmail);
  
  return {
    'List-Unsubscribe': `<${unsubUrl}>, <${mailtoUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
  };
}

// ============================================================
// NATURAL LANGUAGE FOOTER (SAFETY NET)
// ============================================================

/**
 * Footer templates - natural language, not marketing style
 * Approved text with wide clickable anchor
 */
const FOOTER_TEMPLATES = {
  en: {
    // Wide anchor: "let me know here" is all clickable
    text: "P.S. If this isn't relevant for you, just <a href=\"{{unsubscribe_url}}\" style=\"color: #666; text-decoration: underline;\">let me know here</a> and I won't bother you again.",
    plainText: "P.S. If this isn't relevant for you, just let me know here: {{unsubscribe_url}} and I won't bother you again."
  }
};

/**
 * Check if template already contains unsubscribe link
 * 
 * @param {string} content - Email HTML or text content
 * @returns {boolean} - True if unsubscribe link exists
 */
function hasUnsubscribeLink(content) {
  if (!content) return false;
  
  const patterns = [
    /\{\{unsubscribe_url\}\}/i,
    /\{\{unsubscribe_link\}\}/i,
    /\/api\/unsubscribe\//i,
    /unsubscribe/i
  ];
  
  return patterns.some(pattern => pattern.test(content));
}

/**
 * Inject natural language footer if unsubscribe link is missing
 * 
 * @param {string} html - Email HTML content
 * @param {string} unsubscribeUrl - Full unsubscribe URL
 * @param {string} lang - Language code (default: 'en')
 * @returns {string} - HTML with footer injected (if needed)
 */
function injectNaturalFooter(html, unsubscribeUrl, lang = 'en') {
  if (!html) return html;
  
  // If already has unsubscribe link, don't add footer
  if (hasUnsubscribeLink(html)) {
    return html;
  }
  
  const template = FOOTER_TEMPLATES[lang] || FOOTER_TEMPLATES.en;
  const footerHtml = template.text.replace(/\{\{unsubscribe_url\}\}/gi, unsubscribeUrl);
  
  // Style: same font, slightly smaller, muted color
  const styledFooter = `
<div style="margin-top: 24px; padding-top: 16px; font-size: 13px; color: #888; line-height: 1.5;">
  ${footerHtml}
</div>`;

  // Insert before closing </body> or append to end
  if (html.includes('</body>')) {
    return html.replace('</body>', `${styledFooter}</body>`);
  }
  
  return html + styledFooter;
}

/**
 * Inject natural language footer for plain text emails
 * 
 * @param {string} text - Email plain text content
 * @param {string} unsubscribeUrl - Full unsubscribe URL
 * @param {string} lang - Language code (default: 'en')
 * @returns {string} - Text with footer injected (if needed)
 */
function injectNaturalFooterText(text, unsubscribeUrl, lang = 'en') {
  if (!text) return text;
  
  // If already has unsubscribe link, don't add footer
  if (hasUnsubscribeLink(text)) {
    return text;
  }
  
  const template = FOOTER_TEMPLATES[lang] || FOOTER_TEMPLATES.en;
  const footerText = template.plainText.replace(/\{\{unsubscribe_url\}\}/gi, unsubscribeUrl);
  
  return text + '\n\n' + footerText;
}

// ============================================================
// PHYSICAL ADDRESS HANDLING
// ============================================================

/**
 * Format physical address for email footer
 * Single line, minimal styling
 * 
 * @param {string} address - Physical address
 * @returns {string} - Formatted HTML
 */
function formatPhysicalAddress(address) {
  if (!address || !address.trim()) return '';
  
  return `<div style="margin-top: 8px; font-size: 9px; color: #ccc; line-height: 1.4;">${address.trim()}</div>`;
}

/**
 * Validate that organizer has physical address
 * 
 * @param {object} organizer - Organizer object from database
 * @returns {object} - { valid: boolean, error: string|null }
 */
function validatePhysicalAddress(organizer) {
  if (!organizer) {
    return { valid: false, error: 'Organizer not found' };
  }
  
  if (!organizer.physical_address || !organizer.physical_address.trim()) {
    return { 
      valid: false, 
      error: 'Physical address is required for email campaigns. Please update your organization settings.' 
    };
  }
  
  return { valid: true, error: null };
}

// ============================================================
// COMPLETE EMAIL PROCESSING
// ============================================================

/**
 * Process email content with all compliance features
 * - Injects unsubscribe URL into placeholders
 * - Adds natural footer if no unsubscribe link
 * - Adds physical address
 * 
 * @param {object} params
 * @param {string} params.html - Email HTML content
 * @param {string} params.text - Email plain text content
 * @param {string} params.recipientEmail - Recipient email
 * @param {number|string} params.organizerId - Organizer ID
 * @param {string} params.physicalAddress - Physical address (optional)
 * @param {string} params.lang - Language code (default: 'en')
 * @returns {object} - { html, text, unsubscribeUrl }
 */
function processEmailCompliance(params) {
  const {
    html,
    text,
    recipientEmail,
    organizerId,
    physicalAddress,
    lang = 'en'
  } = params;
  
  // Generate unsubscribe URL
  const unsubscribeUrl = getUnsubscribeUrl(recipientEmail, organizerId);
  
  // Process HTML
  let processedHtml = html || '';
  
  // Replace placeholders
  processedHtml = processedHtml.replace(/\{\{unsubscribe_url\}\}/gi, unsubscribeUrl);
  processedHtml = processedHtml.replace(/\{\{unsubscribe_link\}\}/gi, unsubscribeUrl);
  
  // Inject natural footer if needed
  processedHtml = injectNaturalFooter(processedHtml, unsubscribeUrl, lang);
  
  // Add physical address at the very bottom
  if (physicalAddress) {
    const addressHtml = formatPhysicalAddress(physicalAddress);
    if (processedHtml.includes('</body>')) {
      processedHtml = processedHtml.replace('</body>', `${addressHtml}</body>`);
    } else {
      processedHtml += addressHtml;
    }
  }
  
  // Process plain text
  let processedText = text || '';
  processedText = processedText.replace(/\{\{unsubscribe_url\}\}/gi, unsubscribeUrl);
  processedText = processedText.replace(/\{\{unsubscribe_link\}\}/gi, unsubscribeUrl);
  processedText = injectNaturalFooterText(processedText, unsubscribeUrl, lang);
  
  if (physicalAddress) {
    processedText += '\n\n' + physicalAddress.trim();
  }
  
  return {
    html: processedHtml,
    text: processedText,
    unsubscribeUrl
  };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Token operations
  generateUnsubscribeToken,
  verifyUnsubscribeToken,
  
  // URL generation
  getUnsubscribeUrl,
  getUnsubscribeMailto,
  
  // Headers
  getListUnsubscribeHeaders,
  
  // Footer injection
  hasUnsubscribeLink,
  injectNaturalFooter,
  injectNaturalFooterText,
  
  // Physical address
  formatPhysicalAddress,
  validatePhysicalAddress,
  
  // Complete processing
  processEmailCompliance,
  
  // Config (for testing)
  CONFIG
};
