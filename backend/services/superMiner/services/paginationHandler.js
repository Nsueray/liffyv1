/**
 * paginationHandler.js - SuperMiner v3.2
 *
 * Pagination URL generation and page detection for multi-page mining.
 *
 * Generates page URLs from a base URL using detected pagination patterns.
 * Used by FlowOrchestrator to iterate through all pages of a paginated site.
 *
 * URL STRATEGIES (in priority order):
 * 1. Path-based: /page/N/ → replace /page/\d+ with /page/{N}
 * 2. Query-based: ?page=N → replace page=\d+ with page={N}
 * 3. Append: add ?page=N or &page=N
 *
 * DUPLICATE DETECTION:
 * - Hash first 5 contact emails/names per page
 * - If hash matches a previous page, stop (end of content)
 */

const axios = require('axios');
const cheerio = require('cheerio');

// Defaults
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_DELAY_MS = 2000;
const MIN_DELAY_MS = 500;

/**
 * Build a page URL for the given page number.
 *
 * @param {string} baseUrl - Original URL (may already contain ?page=1)
 * @param {number} pageNum - Target page number
 * @returns {string} URL for that page
 */
function buildPageUrl(baseUrl, pageNum) {
    // Strategy 1: Path-based /page/N
    if (/\/page\/\d+/i.test(baseUrl)) {
        return baseUrl.replace(/\/page\/\d+/i, `/page/${pageNum}`);
    }

    // Strategy 2: Query param ?page=N or &page=N
    if (/[?&]page=\d+/i.test(baseUrl)) {
        return baseUrl.replace(/([?&])page=\d+/i, `$1page=${pageNum}`);
    }

    // Strategy 3: Append
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}page=${pageNum}`;
}

/**
 * Detect total page count from HTML content.
 * Looks for numbered pagination links and elements.
 *
 * @param {string} html - Page HTML
 * @param {string} url - Page URL (for context)
 * @returns {number} Detected page count (1 if none detected)
 */
function detectTotalPages(html, url) {
    const $ = cheerio.load(html);
    let maxPage = 1;

    // Method 1: Look for pagination containers
    const paginationSelectors = [
        '.pagination',
        '.paging',
        '[class*="pagination"]',
        'nav[aria-label*="pagination"]',
        '.page-numbers',
        '[class*="pager"]',
        'ul.pages'
    ];

    for (const selector of paginationSelectors) {
        $(selector).find('a, span, li').each((_, el) => {
            const text = $(el).text().trim();
            const num = parseInt(text, 10);
            if (!isNaN(num) && num > 0 && num < 200) {
                maxPage = Math.max(maxPage, num);
            }

            // Also check href for page numbers
            const href = $(el).attr('href') || '';
            const hrefMatch = href.match(/[?&]page=(\d+)/i) || href.match(/\/page\/(\d+)/i);
            if (hrefMatch) {
                const hrefNum = parseInt(hrefMatch[1], 10);
                if (hrefNum > 0 && hrefNum < 200) {
                    maxPage = Math.max(maxPage, hrefNum);
                }
            }
        });
    }

    // Method 2: Scan all links for page numbers (fallback)
    if (maxPage <= 1) {
        $('a').each((_, el) => {
            const href = $(el).attr('href') || '';
            const text = $(el).text().trim();

            // Check href for page param
            const hrefMatch = href.match(/[?&]page=(\d+)/i) || href.match(/\/page\/(\d+)/i);
            if (hrefMatch) {
                const num = parseInt(hrefMatch[1], 10);
                if (num > 0 && num < 200) {
                    maxPage = Math.max(maxPage, num);
                }
            }

            // Check link text for plain numbers (only within pagination-like context)
            const num = parseInt(text, 10);
            if (!isNaN(num) && num > 1 && num < 100 && text === String(num)) {
                // Only count if the link looks like a pagination link
                if (href.includes('page') || href.includes('Page')) {
                    maxPage = Math.max(maxPage, num);
                }
            }
        });
    }

    // Method 3: Look for "Page X of Y" or "Showing X-Y of Z" text
    const bodyText = $('body').text();
    const pageOfMatch = bodyText.match(/page\s+\d+\s+of\s+(\d+)/i);
    if (pageOfMatch) {
        const total = parseInt(pageOfMatch[1], 10);
        if (total > 0 && total < 200) {
            maxPage = Math.max(maxPage, total);
        }
    }

    return maxPage;
}

/**
 * Fetch a page via HTTP and return HTML.
 *
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @returns {Promise<{html: string|null, error: string|null, blocked: boolean}>}
 */
async function fetchPage(url, options = {}) {
    const timeout = options.timeout || 15000;
    const userAgent = options.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

    try {
        const response = await axios.get(url, {
            timeout,
            headers: {
                'User-Agent': userAgent,
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            maxRedirects: 5,
            validateStatus: (status) => status < 500
        });

        if ([401, 403, 429].includes(response.status)) {
            return { html: null, error: `HTTP ${response.status}`, blocked: true };
        }

        return { html: response.data, error: null, blocked: false };
    } catch (err) {
        return { html: null, error: err.message, blocked: false };
    }
}

/**
 * Create a content hash for duplicate detection.
 * Uses first N items to create a fingerprint.
 *
 * @param {Array} contacts - Contact array from miner
 * @returns {string} Content hash
 */
function createContentHash(contacts) {
    if (!contacts || contacts.length === 0) return 'empty';

    const keys = contacts
        .slice(0, 5)
        .map(c => {
            const email = (c.email || '').toLowerCase();
            const name = (c.companyName || c.contactName || '').toLowerCase();
            return `${email}|${name}`;
        })
        .sort();

    return keys.join('::');
}

/**
 * Generate all page URLs for a paginated site.
 * Fetches page 1 to detect total pages, then builds URL list.
 *
 * @param {string} baseUrl - Starting URL
 * @param {Object} config - { max_pages, page1Html }
 * @returns {Promise<{pageUrls: string[], totalPages: number, detectedPages: number}>}
 */
async function generatePageUrls(baseUrl, config = {}) {
    const maxPages = config.max_pages || DEFAULT_MAX_PAGES;

    // If we already have page 1 HTML, use it
    let page1Html = config.page1Html || null;

    if (!page1Html) {
        const result = await fetchPage(baseUrl);
        if (result.error || result.blocked) {
            return { pageUrls: [baseUrl], totalPages: 1, detectedPages: 1 };
        }
        page1Html = result.html;
    }

    const detectedPages = detectTotalPages(page1Html, baseUrl);
    const totalPages = Math.min(detectedPages, maxPages);

    const pageUrls = [];
    for (let i = 1; i <= totalPages; i++) {
        pageUrls.push(buildPageUrl(baseUrl, i));
    }

    return { pageUrls, totalPages, detectedPages };
}

module.exports = {
    buildPageUrl,
    detectTotalPages,
    fetchPage,
    createContentHash,
    generatePageUrls,
    DEFAULT_MAX_PAGES,
    DEFAULT_DELAY_MS,
    MIN_DELAY_MS
};
