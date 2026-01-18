/**
 * pageAnalyzer.js - SuperMiner v3.1
 * 
 * Scout modülü - Sayfa tipini ve yapısını analiz eder.
 * Smart Router'a hangi miner'ı kullanacağını söyler.
 * 
 * KURALLAR:
 * - HTTP ile hızlı analiz (Playwright değil)
 * - Cache kullanır (poisoning korumalı)
 * - Pagination detection
 * - Content type detection
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { getHtmlCache } = require('./htmlCache');

// Page types
const PAGE_TYPES = {
    EXHIBITOR_LIST: 'exhibitor_list',      // List with detail links
    EXHIBITOR_TABLE: 'exhibitor_table',    // Table with direct data
    SINGLE_PAGE: 'single_page',            // All data on one page
    PAGINATED: 'paginated',                // Has pagination
    DYNAMIC: 'dynamic',                     // JS-rendered content
    BLOCKED: 'blocked',                     // Access denied
    ERROR: 'error',                         // Page error
    UNKNOWN: 'unknown'
};

// Pagination types
const PAGINATION_TYPES = {
    NUMBERED: 'numbered',      // ?page=1, ?page=2
    NEXT_BUTTON: 'next',       // Next button
    LOAD_MORE: 'loadmore',     // Load more button
    INFINITE: 'infinite',      // Infinite scroll
    NONE: 'none'
};

// Patterns for exhibitor/contact detection
const EXHIBITOR_PATTERNS = {
    urls: [
        /exhibitor/i,
        /company/i,
        /profile/i,
        /member/i,
        /participant/i,
        /vendor/i,
        /partner/i,
        /sponsor/i
    ],
    selectors: [
        '.exhibitor',
        '.company',
        '.member',
        '.participant',
        '[class*="exhibitor"]',
        '[class*="company"]',
        '[class*="member"]'
    ]
};

// Pagination patterns
const PAGINATION_PATTERNS = {
    numbered: [
        /[?&]page=\d+/i,
        /\/page\/\d+/i,
        /[?&]p=\d+/i,
        /[?&]pg=\d+/i
    ],
    next: [
        'a[rel="next"]',
        '.next',
        '.pagination-next',
        'a:contains("Next")',
        'a:contains("»")',
        '[class*="next"]'
    ],
    loadMore: [
        '.load-more',
        '.loadmore',
        'button:contains("Load More")',
        'button:contains("Show More")',
        '[class*="load-more"]'
    ]
};

class PageAnalyzer {
    constructor() {
        this.cache = getHtmlCache();
        this.timeout = 15000;
        this.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
    }
    
    /**
     * Analyze a URL and return page info
     * @param {string} url 
     * @param {Object} options 
     * @returns {Promise<Object>}
     */
    async analyze(url, options = {}) {
        const startTime = Date.now();
        
        console.log(`[PageAnalyzer] Analyzing: ${url}`);
        
        try {
            // Try to get cached HTML first
            let html = null;
            let fromCache = false;
            
            if (!options.skipCache) {
                const cached = await this.cache.get(url);
                if (cached) {
                    html = cached.html;
                    fromCache = true;
                    console.log(`[PageAnalyzer] Using cached HTML`);
                }
            }
            
            // Fetch if not cached
            if (!html) {
                const fetchResult = await this.fetchPage(url);
                
                if (fetchResult.blocked) {
                    return {
                        url,
                        pageType: PAGE_TYPES.BLOCKED,
                        httpCode: fetchResult.httpCode,
                        reason: fetchResult.reason,
                        analysisTime: Date.now() - startTime,
                        recommendation: {
                            miner: 'playwrightMiner',
                            reason: 'Page blocked for HTTP, try Playwright'
                        }
                    };
                }
                
                if (fetchResult.error) {
                    return {
                        url,
                        pageType: PAGE_TYPES.ERROR,
                        error: fetchResult.error,
                        analysisTime: Date.now() - startTime,
                        recommendation: null
                    };
                }
                
                html = fetchResult.html;
                
                // Cache the HTML (if not poisoned)
                await this.cache.set(url, html, { httpCode: fetchResult.httpCode });
            }
            
            // Analyze the HTML
            const analysis = this.analyzeHtml(html, url);
            
            // Determine recommendation
            const recommendation = this.getRecommendation(analysis);
            
            return {
                url,
                ...analysis,
                fromCache,
                analysisTime: Date.now() - startTime,
                recommendation
            };
            
        } catch (err) {
            console.error(`[PageAnalyzer] Error analyzing ${url}:`, err.message);
            
            return {
                url,
                pageType: PAGE_TYPES.ERROR,
                error: err.message,
                analysisTime: Date.now() - startTime,
                recommendation: {
                    miner: 'playwrightMiner',
                    reason: 'HTTP analysis failed, try Playwright'
                }
            };
        }
    }
    
    /**
     * Fetch page with HTTP
     */
    async fetchPage(url) {
        try {
            const response = await axios.get(url, {
                timeout: this.timeout,
                headers: {
                    'User-Agent': this.userAgent,
                    'Accept': 'text/html,application/xhtml+xml',
                    'Accept-Language': 'en-US,en;q=0.9'
                },
                maxRedirects: 5,
                validateStatus: (status) => status < 500
            });
            
            const httpCode = response.status;
            
            // Check for blocks
            if ([401, 403, 429].includes(httpCode)) {
                return {
                    blocked: true,
                    httpCode,
                    reason: `HTTP ${httpCode}`
                };
            }
            
            return {
                html: response.data,
                httpCode,
                blocked: false
            };
            
        } catch (err) {
            if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
                return { error: 'Timeout', blocked: false };
            }
            
            if (err.response) {
                return {
                    blocked: true,
                    httpCode: err.response.status,
                    reason: err.message
                };
            }
            
            return { error: err.message, blocked: false };
        }
    }
    
    /**
     * Analyze HTML content
     */
    analyzeHtml(html, url) {
        const $ = cheerio.load(html);
        
        const result = {
            pageType: PAGE_TYPES.UNKNOWN,
            paginationType: PAGINATION_TYPES.NONE,
            hasEmails: false,
            emailCount: 0,
            hasDetailLinks: false,
            detailLinkCount: 0,
            hasTable: false,
            tableCount: 0,
            hasDynamicIndicators: false,
            contentLength: html.length,
            textLength: $('body').text().trim().length
        };
        
        // Email detection
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        const emails = html.match(emailRegex) || [];
        const uniqueEmails = [...new Set(emails.filter(e => 
            !e.includes('wix.com') && 
            !e.includes('sentry.io') &&
            !e.includes('example.com')
        ))];
        
        result.hasEmails = uniqueEmails.length > 0;
        result.emailCount = uniqueEmails.length;
        
        // Table detection
        const tables = $('table');
        result.hasTable = tables.length > 0;
        result.tableCount = tables.length;
        
        // Detail link detection
        const detailLinks = this.findDetailLinks($, url);
        result.hasDetailLinks = detailLinks.length > 0;
        result.detailLinkCount = detailLinks.length;
        result.detailLinks = detailLinks.slice(0, 10); // Sample
        
        // Pagination detection
        result.paginationType = this.detectPagination($, url, html);
        
        // Dynamic content indicators
        result.hasDynamicIndicators = this.detectDynamic($, html);
        
        // Determine page type
        result.pageType = this.determinePageType(result);
        
        return result;
    }
    
    /**
     * Find exhibitor/detail links
     */
    findDetailLinks($, baseUrl) {
        const links = [];
        const seen = new Set();
        
        let baseHost;
        try {
            baseHost = new URL(baseUrl).hostname;
        } catch {
            return links;
        }
        
        $('a[href]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            
            let fullUrl;
            try {
                fullUrl = new URL(href, baseUrl).href;
                const urlHost = new URL(fullUrl).hostname;
                
                // Must be same domain
                if (urlHost !== baseHost) return;
                
            } catch {
                return;
            }
            
            // Skip pagination/anchors
            if (href.startsWith('#')) return;
            if (/[?&]page=/i.test(href)) return;
            
            // Check for exhibitor patterns
            const isExhibitorLink = EXHIBITOR_PATTERNS.urls.some(p => p.test(fullUrl));
            
            // Check if longer than base (likely detail page)
            const isDetailPage = fullUrl.length > baseUrl.length + 5 && !seen.has(fullUrl);
            
            if ((isExhibitorLink || isDetailPage) && !seen.has(fullUrl)) {
                seen.add(fullUrl);
                links.push(fullUrl);
            }
        });
        
        return links;
    }
    
    /**
     * Detect pagination type
     */
    detectPagination($, url, html) {
        // Check numbered pagination in URL patterns
        for (const pattern of PAGINATION_PATTERNS.numbered) {
            if (pattern.test(html)) {
                return PAGINATION_TYPES.NUMBERED;
            }
        }
        
        // Check for pagination elements
        const paginationSelectors = [
            '.pagination',
            '.paging',
            '[class*="pagination"]',
            'nav[aria-label*="pagination"]'
        ];
        
        for (const selector of paginationSelectors) {
            if ($(selector).length > 0) {
                // Check if has page numbers
                const pageLinks = $(selector).find('a').filter((_, el) => {
                    const text = $(el).text().trim();
                    return /^\d+$/.test(text);
                });
                
                if (pageLinks.length > 0) {
                    return PAGINATION_TYPES.NUMBERED;
                }
            }
        }
        
        // Check for next button
        for (const selector of PAGINATION_PATTERNS.next) {
            try {
                if ($(selector).length > 0) {
                    return PAGINATION_TYPES.NEXT_BUTTON;
                }
            } catch {
                // Invalid selector
            }
        }
        
        // Check for load more
        for (const selector of PAGINATION_PATTERNS.loadMore) {
            try {
                if ($(selector).length > 0) {
                    return PAGINATION_TYPES.LOAD_MORE;
                }
            } catch {
                // Invalid selector
            }
        }
        
        return PAGINATION_TYPES.NONE;
    }
    
    /**
     * Detect dynamic/JS content indicators
     */
    detectDynamic($, html) {
        const indicators = [
            // React/Vue/Angular
            /react/i.test(html),
            /vue/i.test(html),
            /angular/i.test(html),
            /__NEXT_DATA__/.test(html),
            /__NUXT__/.test(html),
            
            // Dynamic loading
            $('[data-src]').length > 0,
            $('[data-lazy]').length > 0,
            $('[v-if]').length > 0,
            $('[ng-if]').length > 0,
            
            // Very little content (JS might load it)
            $('body').text().trim().length < 500 && html.length > 10000
        ];
        
        return indicators.some(Boolean);
    }
    
    /**
     * Determine page type from analysis
     */
    determinePageType(analysis) {
        // If has table with emails, likely exhibitor table
        if (analysis.hasTable && analysis.emailCount > 5) {
            return PAGE_TYPES.EXHIBITOR_TABLE;
        }
        
        // If has detail links, it's a list page
        if (analysis.hasDetailLinks && analysis.detailLinkCount > 5) {
            if (analysis.paginationType !== PAGINATION_TYPES.NONE) {
                return PAGE_TYPES.PAGINATED;
            }
            return PAGE_TYPES.EXHIBITOR_LIST;
        }
        
        // If has emails but no links/pagination, single page
        if (analysis.hasEmails && analysis.emailCount > 3) {
            return PAGE_TYPES.SINGLE_PAGE;
        }
        
        // If dynamic indicators, need Playwright
        if (analysis.hasDynamicIndicators) {
            return PAGE_TYPES.DYNAMIC;
        }
        
        return PAGE_TYPES.UNKNOWN;
    }
    
    /**
     * Get miner recommendation
     */
    getRecommendation(analysis) {
        switch (analysis.pageType) {
            case PAGE_TYPES.EXHIBITOR_TABLE:
                return {
                    miner: analysis.hasDynamicIndicators ? 'playwrightTableMiner' : 'httpBasicMiner',
                    useCache: !analysis.hasDynamicIndicators,
                    reason: 'Table with direct email data'
                };
                
            case PAGE_TYPES.SINGLE_PAGE:
                return {
                    miner: analysis.hasDynamicIndicators ? 'playwrightTableMiner' : 'httpBasicMiner',
                    useCache: !analysis.hasDynamicIndicators,
                    reason: 'Single page with all data visible'
                };
                
            case PAGE_TYPES.EXHIBITOR_LIST:
                return {
                    miner: 'aiMiner',
                    useCache: true, // AI can use cached HTML
                    reason: 'List with detail links, AI best for extraction'
                };
                
            case PAGE_TYPES.PAGINATED:
                return {
                    miner: 'playwrightMiner',
                    useCache: false, // Playwright never caches
                    needsPagination: true,
                    paginationType: analysis.paginationType,
                    reason: 'Paginated content needs Playwright for navigation'
                };
                
            case PAGE_TYPES.DYNAMIC:
                return {
                    miner: 'playwrightMiner',
                    useCache: false, // Playwright never caches
                    reason: 'Dynamic/JS content needs Playwright'
                };
                
            case PAGE_TYPES.BLOCKED:
                return {
                    miner: 'playwrightMiner',
                    useCache: false,
                    reason: 'Blocked for HTTP, try with browser'
                };
                
            default:
                return {
                    miner: 'aiMiner',
                    useCache: true,
                    reason: 'Unknown page type, AI for best results'
                };
        }
    }
}

// Singleton
let instance = null;

function getPageAnalyzer() {
    if (!instance) {
        instance = new PageAnalyzer();
    }
    return instance;
}

module.exports = {
    PageAnalyzer,
    getPageAnalyzer,
    PAGE_TYPES,
    PAGINATION_TYPES
};
