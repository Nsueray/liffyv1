/**
 * Cloudflare Email Decoder
 * Decodes emails protected by Cloudflare's email obfuscation
 * 
 * Cloudflare encodes emails like:
 * <a href="/cdn-cgi/l/email-protection#abc9c4c9ebccc6cac2c785c8c4c6">
 * [email&#160;protected]
 * </a>
 * 
 * The hex string after # is XOR encoded with first byte as key
 */

/**
 * Decode a single Cloudflare encoded email
 * @param {string} encodedString - Hex string (e.g., "abc9c4c9ebccc6cac2c785c8c4c6")
 * @returns {string|null} - Decoded email or null
 */
function decodeEmail(encodedString) {
    if (!encodedString || encodedString.length < 2) return null;
    
    try {
        // First two chars are the XOR key
        const key = parseInt(encodedString.substring(0, 2), 16);
        if (isNaN(key)) return null;
        
        let decoded = '';
        for (let i = 2; i < encodedString.length; i += 2) {
            const charCode = parseInt(encodedString.substring(i, i + 2), 16) ^ key;
            decoded += String.fromCharCode(charCode);
        }
        
        // Validate it looks like an email
        if (decoded.includes('@') && decoded.includes('.')) {
            return decoded.toLowerCase().trim();
        }
        return null;
    } catch (e) {
        return null;
    }
}

/**
 * Extract all Cloudflare protected emails from HTML
 * @param {string} html - Raw HTML content
 * @returns {string[]} - Array of decoded emails
 */
function extractCloudflareEmails(html) {
    if (!html) return [];
    
    const emails = new Set();
    
    // Pattern 1: href="/cdn-cgi/l/email-protection#HEXSTRING"
    const hrefPattern = /\/cdn-cgi\/l\/email-protection#([a-f0-9]+)/gi;
    let match;
    while ((match = hrefPattern.exec(html)) !== null) {
        const decoded = decodeEmail(match[1]);
        if (decoded) emails.add(decoded);
    }
    
    // Pattern 2: data-cfemail="HEXSTRING"
    const dataPattern = /data-cfemail="([a-f0-9]+)"/gi;
    while ((match = dataPattern.exec(html)) !== null) {
        const decoded = decodeEmail(match[1]);
        if (decoded) emails.add(decoded);
    }
    
    return Array.from(emails);
}

/**
 * Extract regular (non-protected) emails from text
 * @param {string} text - Text content
 * @returns {string[]} - Array of emails
 */
function extractRegularEmails(text) {
    if (!text) return [];
    
    const regex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
    const matches = text.match(regex) || [];
    
    const normalized = matches
        .map(e => e.trim().toLowerCase().replace(/[,;:.]+$/, ''))
        .filter(e => {
            // Filter out common false positives
            if (e.includes('example.com')) return false;
            if (e.includes('email.com')) return false;
            if (e.includes('domain.com')) return false;
            if (e.startsWith('noreply@')) return false;
            if (e.length < 6) return false;
            return true;
        });
    
    return Array.from(new Set(normalized));
}

/**
 * Extract ALL emails from HTML (both CF protected and regular)
 * @param {string} html - Raw HTML content
 * @returns {string[]} - Array of all unique emails
 */
function extractAllEmails(html) {
    if (!html) return [];
    
    const cfEmails = extractCloudflareEmails(html);
    const regularEmails = extractRegularEmails(html);
    
    const all = new Set([...cfEmails, ...regularEmails]);
    return Array.from(all);
}

module.exports = {
    decodeEmail,
    extractCloudflareEmails,
    extractRegularEmails,
    extractAllEmails,
};
