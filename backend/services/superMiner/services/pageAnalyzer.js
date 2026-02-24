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
    DOCUMENT_VIEWER: 'document_viewer',    // Flipbook/PDF viewer
    DIRECTORY: 'directory',                // Business directory (Yellow Pages, etc.)
    SPA_CATALOG: 'spa_catalog',            // SPA/API-driven catalog (Vue/React, data from JSON API)
    MESSE_FRANKFURT: 'messe_frankfurt',    // Messe Frankfurt exhibition exhibitor catalogs
    MEMBER_TABLE: 'member_table',          // HTML table member/exhibitor lists (associations, chambers)
    VIS_EXHIBITOR: 'vis_exhibitor',        // Messe Düsseldorf VIS platform exhibitor catalogs
    FLIPBOOK_HTML: 'flipbook_html',        // Flipbuilder/FlipHTML5 basic-html flipbook pages
    UNKNOWN: 'unknown'
};

// Known business directory domains — hostname-based detection (Step 9 Phase 2)
const DIRECTORY_DOMAINS = [
    'yellowpages', 'yell.com', 'goldenpages', 'ghanayello',
    'yelp.com', 'justdial', 'europages', 'thomasnet',
    'kompass', 'hotfrog', 'cylex', 'infobel',
    'businesslist', 'dnb.com', 'manta.com', 'glmis.gov.gh'
];

// Known SPA catalog domains — data comes from JSON APIs, not DOM
const SPA_CATALOG_DOMAINS = [
    'apps.feriavalencia.com',
];

// Messe Frankfurt domains — exhibitor data comes from dedicated API
const MESSE_FRANKFURT_DOMAINS = [
    'messefrankfurt.com'
];

// Member table domains — HTML table member/exhibitor lists
const MEMBER_TABLE_DOMAINS = [
    'aiacra.com'
];

// Flipbook platform domains — basic-html flipbook pages
const FLIPBOOK_DOMAINS = [
    'flipbuilder.com', 'online.flipbuilder.com',
    'fliphtml5.com', 'online.fliphtml5.com',
    'online.anyflip.com', 'publuu.com'
];

// VIS platform domains — Messe Düsseldorf VIS exhibitor catalogs
const VIS_DOMAINS = [
    'valveworldexpo.com',
    'wire-tradefair.com',
    'tube-tradefair.com',
    'interpack.com',
    'k-online.com',
    'prowein.com',
    'medica-tradefair.com',
    'compamed-tradefair.com'
];

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
            // Early URL pattern check — .pdf URLs cannot be HTML-analyzed
            // Must happen BEFORE fetchPage() to prevent binary download
            try {
                const urlPath = new URL(url).pathname.toLowerCase();
                if (urlPath.endsWith('.pdf')) {
                    console.log(`[PageAnalyzer] PDF URL detected, skipping HTML analysis: ${url}`);
                    return {
                        url,
                        pageType: PAGE_TYPES.DOCUMENT_VIEWER,
                        isPdfUrl: true,
                        contentLength: 0,
                        analysisTime: Date.now() - startTime,
                        recommendation: {
                            miner: 'documentMiner',
                            useCache: false,
                            reason: 'Direct PDF URL, using documentMiner'
                        }
                    };
                }
            } catch (e) {
                // Invalid URL, continue with normal analysis
            }

            // Early hostname-based detection — runs BEFORE fetchPage() so that
            // sites with SSL errors or other HTTP failures still get routed correctly.
            // Without this, expired-SSL sites fall through to PAGE_TYPES.ERROR → playwrightMiner.
            try {
                const parsedUrl = new URL(url);
                const hostname = parsedUrl.hostname.toLowerCase();
                const fullUrl = url.toLowerCase();

                // Flipbook basic-html pages (Flipbuilder, FlipHTML5, AnyFlip, Publuu)
                if (FLIPBOOK_DOMAINS.some(d => hostname.includes(d)) && /basic-html\/page\d+/i.test(fullUrl)) {
                    console.log(`[PageAnalyzer] Early detection: FLIPBOOK_HTML via hostname: ${hostname}`);
                    return {
                        url,
                        pageType: PAGE_TYPES.FLIPBOOK_HTML,
                        isFlipbookHtml: true,
                        analysisTime: Date.now() - startTime,
                        recommendation: {
                            miner: 'flipbookMiner',
                            useCache: false,
                            reason: 'Flipbook basic-html pages (early hostname match)',
                            ownPagination: true
                        }
                    };
                }

                // VIS platform sites (Messe Düsseldorf)
                if (VIS_DOMAINS.some(d => hostname.includes(d)) && (fullUrl.includes('/vis/') || fullUrl.includes('/directory/'))) {
                    console.log(`[PageAnalyzer] Early detection: VIS_EXHIBITOR via hostname: ${hostname}`);
                    return {
                        url,
                        pageType: PAGE_TYPES.VIS_EXHIBITOR,
                        isVisExhibitor: true,
                        analysisTime: Date.now() - startTime,
                        recommendation: {
                            miner: 'visExhibitorMiner',
                            useCache: false,
                            reason: 'Messe Düsseldorf VIS exhibitor catalog (early hostname match)',
                            ownPagination: true
                        }
                    };
                }

                // Member table sites
                if (MEMBER_TABLE_DOMAINS.some(d => hostname.includes(d)) && fullUrl.includes('member')) {
                    console.log(`[PageAnalyzer] Early detection: MEMBER_TABLE via hostname: ${hostname}`);
                    return {
                        url,
                        pageType: PAGE_TYPES.MEMBER_TABLE,
                        isMemberTable: true,
                        analysisTime: Date.now() - startTime,
                        recommendation: {
                            miner: 'memberTableMiner',
                            useCache: false,
                            reason: 'HTML table member list detected (early hostname match)',
                            ownPagination: false
                        }
                    };
                }

                // Directory sites
                if (DIRECTORY_DOMAINS.some(d => hostname.includes(d))) {
                    console.log(`[PageAnalyzer] Early detection: DIRECTORY via hostname: ${hostname}`);
                    return {
                        url,
                        pageType: PAGE_TYPES.DIRECTORY,
                        isDirectory: true,
                        analysisTime: Date.now() - startTime,
                        recommendation: {
                            miner: 'directoryMiner',
                            useCache: false,
                            reason: 'Business directory detected (early hostname match)',
                            ownPagination: true
                        }
                    };
                }

                // Messe Frankfurt sites
                if (MESSE_FRANKFURT_DOMAINS.some(d => hostname.includes(d)) && parsedUrl.pathname.toLowerCase().includes('exhibitor')) {
                    console.log(`[PageAnalyzer] Early detection: MESSE_FRANKFURT via hostname: ${hostname}`);
                    return {
                        url,
                        pageType: PAGE_TYPES.MESSE_FRANKFURT,
                        isMesseFrankfurt: true,
                        analysisTime: Date.now() - startTime,
                        recommendation: {
                            miner: 'messeFrankfurtMiner',
                            useCache: false,
                            reason: 'Messe Frankfurt exhibitor catalog (early hostname match)',
                            ownPagination: true
                        }
                    };
                }
            } catch (e) {
                // Invalid URL, continue with normal analysis
            }

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
    PAGINATION_TYPES,
    DIRECTORY_DOMAINS,
    SPA_CATALOG_DOMAINS,
    MESSE_FRANKFURT_DOMAINS,
    MEMBER_TABLE_DOMAINS,
    VIS_DOMAINS,
    FLIPBOOK_DOMAINS
};

// ============================================
// DOCUMENT VIEWER DETECTION (Added v1.2)
// ============================================
PageAnalyzer.prototype.detectDocumentViewer = function($, html, url) {
    const bodyText = $('body').text();
    const scriptContent = $('script').text();
    const fullContent = html + scriptContent;
    
    let score = 0;
    const indicators = [];
    
    // SEO text layer check (P:XX pattern) - Strong indicator
    const pageMatches = bodyText.match(/P:\d+[\s\S]{20,}?(?=P:\d+|$)/g) || [];
    if (pageMatches.length >= 3) {
        score += 50;
        indicators.push('seo_text_pages:' + pageMatches.length);
    }
    
    // Canvas elements - Medium indicator
    const canvasCount = $('canvas').length;
    if (canvasCount >= 2) {
        score += 20;
        indicators.push('canvas_elements:' + canvasCount);
    }
    
    // JSON API indicators in content (NOT domain-based)
    if (/pages\.json|documentPages|bookData|textContent/i.test(fullContent)) {
        score += 15;
        indicators.push('json_api_indicator');
    }
    
    // Flipbook class patterns
    if (/flipbook|pageflip|book-viewer|document-viewer/i.test(fullContent)) {
        score += 15;
        indicators.push('flipbook_class');
    }
    
    // PDF links
    const pdfLinks = $('a[href*=".pdf"]').length;
    if (pdfLinks > 0) {
        score += 10;
        indicators.push('pdf_links:' + pdfLinks);
    }
    
    return {
        isDocumentViewer: score >= 40,
        indicators: indicators,
        confidence: Math.min(100, score),
    };
};

// ============================================
// SPA CATALOG DETECTION (Added v1.3)
// ============================================
PageAnalyzer.prototype.detectSpaCatalog = function($, html, url) {
    // ── Generic SPA detection rules ──
    const $bodyClone = $('body').clone();
    $bodyClone.find('script, style').remove();
    const contentHtml = ($bodyClone.html() || '').trim();
    const scriptCount = $('script').length;
    const bodyText = $('body').text().trim();

    // Rule 1: Very little content HTML (excluding scripts/styles) + script-heavy
    if (contentHtml.length < 15000 && scriptCount > 3) {
        return { isSpa: true, method: 'generic rules', reason: `small HTML (${contentHtml.length}B) + ${scriptCount} scripts` };
    }

    // Rule 2: SPA root containers with empty/minimal content
    const spaRoots = ['#app', '#root', '#__nuxt', '#__next'];
    for (const sel of spaRoots) {
        const el = $(sel);
        if (el.length > 0 && el.text().trim().length < 200) {
            return { isSpa: true, method: 'generic rules', reason: `empty SPA root: ${sel}` };
        }
    }

    // Rule 3: "enable JavaScript" / "doesn't work without JavaScript" message
    if (/enable javascript|doesn'?t work without javascript|javascript is required|please enable javascript/i.test(bodyText)) {
        return { isSpa: true, method: 'generic rules', reason: 'JavaScript required message' };
    }

    // Rule 4: Framework indicators in meta tags
    const metaContent = $('meta').map((_, el) => $(el).attr('content') || '').get().join(' ');
    const metaNames = $('meta').map((_, el) => $(el).attr('name') || '').get().join(' ');
    const metaAll = metaContent + ' ' + metaNames;
    if (/\b(vue|react|angular|nuxt|next)\b/i.test(metaAll)) {
        return { isSpa: true, method: 'generic rules', reason: 'framework meta tag' };
    }

    // Fallback: hostname match from known SPA catalog list
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        if (SPA_CATALOG_DOMAINS.some(d => hostname.includes(d))) {
            return { isSpa: true, method: 'hostname', reason: hostname };
        }
    } catch (e) { /* invalid URL */ }

    return { isSpa: false };
};

// Override analyzeHtml to include directory + document viewer detection
const originalAnalyzeHtml = PageAnalyzer.prototype.analyzeHtml;
PageAnalyzer.prototype.analyzeHtml = function(html, url) {
    const result = originalAnalyzeHtml.call(this, html, url);

    // Directory detection (hostname-based) — after ERROR/BLOCKED, before other heuristics
    // Step 9 Phase 2: directoryMiner handles its own pagination, so this must be detected
    // early to prevent double-pagination in flowOrchestrator.
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        if (DIRECTORY_DOMAINS.some(d => hostname.includes(d))) {
            result.pageType = PAGE_TYPES.DIRECTORY;
            result.isDirectory = true;
            console.log(`[PageAnalyzer] Directory detected via hostname: ${hostname}`);
            return result; // Skip document viewer — directory takes priority
        }
    } catch (e) {
        // Invalid URL, continue to other checks
    }
    result.isDirectory = false;

    // Messe Frankfurt detection (hostname + exhibitor path)
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        const pathname = new URL(url).pathname.toLowerCase();
        if (MESSE_FRANKFURT_DOMAINS.some(d => hostname.includes(d)) && pathname.includes('exhibitor')) {
            result.pageType = PAGE_TYPES.MESSE_FRANKFURT;
            result.isMesseFrankfurt = true;
            console.log(`[PageAnalyzer] Messe Frankfurt detected via hostname: ${hostname}`);
            return result;
        }
    } catch (e) {
        // Invalid URL, continue to other checks
    }
    result.isMesseFrankfurt = false;

    // Flipbook basic-html detection (hostname + page{N}.html pattern)
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        const fullUrl = url.toLowerCase();
        if (FLIPBOOK_DOMAINS.some(d => hostname.includes(d)) && /basic-html\/page\d+/i.test(fullUrl)) {
            result.pageType = PAGE_TYPES.FLIPBOOK_HTML;
            result.isFlipbookHtml = true;
            console.log(`[PageAnalyzer] Flipbook HTML detected via hostname: ${hostname}`);
            return result;
        }
    } catch (e) {
        // Invalid URL, continue to other checks
    }
    result.isFlipbookHtml = false;

    // VIS platform detection (hostname + /vis/ or /directory/ in URL)
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        const fullUrl = url.toLowerCase();
        if (VIS_DOMAINS.some(d => hostname.includes(d)) && (fullUrl.includes('/vis/') || fullUrl.includes('/directory/'))) {
            result.pageType = PAGE_TYPES.VIS_EXHIBITOR;
            result.isVisExhibitor = true;
            console.log(`[PageAnalyzer] VIS exhibitor detected via hostname: ${hostname}`);
            return result;
        }
    } catch (e) {
        // Invalid URL, continue to other checks
    }
    result.isVisExhibitor = false;

    // Member table detection (hostname + 'member' in URL)
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        const fullUrl = url.toLowerCase();
        if (MEMBER_TABLE_DOMAINS.some(d => hostname.includes(d)) && fullUrl.includes('member')) {
            result.pageType = PAGE_TYPES.MEMBER_TABLE;
            result.isMemberTable = true;
            console.log(`[PageAnalyzer] Member table detected via hostname: ${hostname}`);
            return result;
        }
    } catch (e) {
        // Invalid URL, continue to other checks
    }
    result.isMemberTable = false;

    // Content-based MEMBER_TABLE detection — generic, no hostname dependency.
    // Looks for HTML tables with semantic <th> header rows that map to contact fields.
    // Conditions (ALL must be true):
    //   1. <table> exists
    //   2. Table has a <th> header row
    //   3. Header keywords match ≥3 distinct field types
    //   4. ≥3 data rows contain email patterns
    const $ = cheerio.load(html);
    try {
        const MEMBER_HEADER_KEYWORDS = {
            company_name: ['company', 'organization', 'organisation', 'firm', 'firma',
                'şirket', 'member', 'üye', 'exhibitor', 'company name', 'member name'],
            email: ['email', 'e-mail', 'mail', 'e mail', 'contact details',
                'contact info', 'contact information', 'e-posta'],
            phone: ['phone', 'tel', 'telephone', 'mobile', 'contact no', 'telefon'],
            contact_name: ['contact person', 'person', 'representative',
                'contact name', 'kişi', 'temsilci', 'yetkili', 'authorized person'],
            city: ['city', 'location', 'place', 'şehir', 'town'],
            address: ['address', 'adres'],
            country: ['country', 'ülke'],
            website: ['website', 'web', 'url', 'homepage']
        };
        const emailDetectRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;

        const tables = $('table');
        for (let tIdx = 0; tIdx < tables.length; tIdx++) {
            const table = $(tables[tIdx]);
            const rows = table.find('tr');
            if (rows.length < 4) continue; // need header + ≥3 data rows

            // Find header row in first 3 rows
            let headerRowIdx = -1;
            let matchedFieldSet = new Set();

            for (let rIdx = 0; rIdx < Math.min(3, rows.length); rIdx++) {
                const ths = $(rows[rIdx]).find('th');
                if (ths.length < 2) continue;

                const fields = new Set();
                ths.each((_, th) => {
                    const cellText = $(th).text().toLowerCase().trim();
                    if (!cellText) return;
                    for (const [field, keywords] of Object.entries(MEMBER_HEADER_KEYWORDS)) {
                        if (keywords.some(kw => cellText.includes(kw))) {
                            fields.add(field);
                        }
                    }
                });

                if (fields.size >= 3) {
                    headerRowIdx = rIdx;
                    matchedFieldSet = fields;
                    break;
                }
            }

            if (headerRowIdx < 0) continue;

            // Count data rows with email
            let emailRowCount = 0;
            for (let rIdx = headerRowIdx + 1; rIdx < rows.length; rIdx++) {
                const rowText = $(rows[rIdx]).text();
                if (emailDetectRegex.test(rowText)) {
                    emailRowCount++;
                }
            }

            if (emailRowCount >= 3) {
                const fieldNames = Array.from(matchedFieldSet).join(', ');
                result.pageType = PAGE_TYPES.MEMBER_TABLE;
                result.isMemberTable = true;
                console.log(`[PageAnalyzer] Member table detected via content: ${matchedFieldSet.size} fields (${fieldNames}), ${emailRowCount} email rows`);
                return result;
            }
        }
    } catch (e) {
        // Content detection failed, continue to other checks
    }

    // SPA catalog detection — generic rules first, hostname as fallback
    // (reuse $ from content-based detection above)
    const spaDetection = this.detectSpaCatalog($, html, url);
    if (spaDetection.isSpa) {
        result.pageType = PAGE_TYPES.SPA_CATALOG;
        result.isSpaCatalog = true;
        console.log(`[PageAnalyzer] SPA catalog detected via ${spaDetection.method}: ${spaDetection.reason}`);
        return result;
    }
    result.isSpaCatalog = false;

    // Document viewer detection (reuse $ from above)
    const docViewerAnalysis = this.detectDocumentViewer($, html, url);

    result.isDocumentViewer = docViewerAnalysis.isDocumentViewer;
    result.documentViewerIndicators = docViewerAnalysis.indicators;

    // Override pageType if document viewer detected
    if (result.isDocumentViewer) {
        result.pageType = PAGE_TYPES.DOCUMENT_VIEWER;
        console.log('[PageAnalyzer] Document viewer detected:', docViewerAnalysis.indicators.join(', '));
    }

    return result;
};

// Override getRecommendation to handle DIRECTORY + DOCUMENT_VIEWER
const originalGetRecommendation = PageAnalyzer.prototype.getRecommendation;
PageAnalyzer.prototype.getRecommendation = function(analysis) {
    if (analysis.pageType === PAGE_TYPES.DIRECTORY) {
        return {
            miner: 'directoryMiner',
            useCache: false, // Playwright-based, no cache
            reason: 'Business directory detected, using directoryMiner',
            ownPagination: true // directoryMiner handles its own pagination
        };
    }
    if (analysis.pageType === PAGE_TYPES.MEMBER_TABLE) {
        return {
            miner: 'memberTableMiner',
            useCache: false,
            reason: 'HTML table member list detected, using memberTableMiner',
            ownPagination: false
        };
    }
    if (analysis.pageType === PAGE_TYPES.MESSE_FRANKFURT) {
        return {
            miner: 'messeFrankfurtMiner',
            useCache: false,
            reason: 'Messe Frankfurt exhibitor catalog',
            ownPagination: true
        };
    }
    if (analysis.pageType === PAGE_TYPES.VIS_EXHIBITOR) {
        return {
            miner: 'visExhibitorMiner',
            useCache: false,
            reason: 'Messe Düsseldorf VIS exhibitor catalog',
            ownPagination: true
        };
    }
    if (analysis.pageType === PAGE_TYPES.SPA_CATALOG) {
        return {
            miner: 'spaNetworkMiner',
            useCache: false, // Playwright-based, no cache
            reason: 'SPA catalog detected, using spaNetworkMiner',
            ownPagination: true // spaNetworkMiner handles its own data fetching
        };
    }
    if (analysis.pageType === PAGE_TYPES.FLIPBOOK_HTML) {
        return {
            miner: 'flipbookMiner',
            useCache: false,
            reason: 'Flipbook basic-html pages detected, using flipbookMiner',
            ownPagination: true
        };
    }
    if (analysis.pageType === PAGE_TYPES.DOCUMENT_VIEWER) {
        return {
            miner: 'documentMiner',
            useCache: true,
            reason: 'Document viewer detected, using DocumentMiner',
            indicators: analysis.documentViewerIndicators || []
        };
    }
    return originalGetRecommendation.call(this, analysis);
};
