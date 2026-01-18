/**
 * websiteScraperMinerAdapter.js - SuperMiner v3.1
 * 
 * Adapter for Website Scraper (Flow 2 - Deep Crawl)
 * 
 * KURALLAR:
 * - Flow 2'de kullanılır (enrichment için)
 * - ASLA cache kullanmaz (useCache: false) - FRESH FETCH zorunlu
 * - Cost: $0.005 per page
 * - Company website'lerinden ek contact bilgisi çeker
 */

const { BaseMinerAdapter } = require('./baseMinerAdapter');
const { getCostTracker, OPERATION_COSTS } = require('../services/costTracker');
const { createEvidence, EVIDENCE_TYPES } = require('../pipeline/hallucinationFilter');

/**
 * Simple website scraper function
 * This is a basic implementation - can be enhanced later
 */
async function scrapeWebsite(url, options = {}) {
    const { chromium } = require('playwright');
    
    const maxPages = options.maxPages || 3;
    const timeout = options.timeout || 30000;
    
    let browser;
    const results = {
        contacts: [],
        emails: new Set(),
        phones: new Set(),
        pages_crawled: 0
    };
    
    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage']
        });
        
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        });
        
        const page = await context.newPage();
        
        // Pages to check for contact info
        const contactPages = [
            url,
            url.replace(/\/$/, '') + '/contact',
            url.replace(/\/$/, '') + '/contact-us',
            url.replace(/\/$/, '') + '/about',
            url.replace(/\/$/, '') + '/about-us',
            url.replace(/\/$/, '') + '/team'
        ];
        
        for (let i = 0; i < Math.min(contactPages.length, maxPages); i++) {
            const pageUrl = contactPages[i];
            
            try {
                const response = await page.goto(pageUrl, {
                    waitUntil: 'networkidle',
                    timeout
                });
                
                if (!response || response.status() >= 400) {
                    continue;
                }
                
                results.pages_crawled++;
                
                // Extract emails
                const html = await page.content();
                const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
                const emails = html.match(emailRegex) || [];
                
                emails.forEach(email => {
                    const lower = email.toLowerCase();
                    // Filter out garbage
                    if (!lower.includes('wix.com') && 
                        !lower.includes('sentry.io') &&
                        !lower.includes('example.com')) {
                        results.emails.add(lower);
                    }
                });
                
                // Extract phones
                const text = await page.evaluate(() => document.body.innerText);
                const phoneRegex = /(?:\+?[\d\s\-().]{10,20})/g;
                const phones = text.match(phoneRegex) || [];
                
                phones.forEach(phone => {
                    const digits = phone.replace(/\D/g, '');
                    if (digits.length >= 10 && digits.length <= 15) {
                        results.phones.add(phone.trim());
                    }
                });
                
            } catch (err) {
                // Skip failed pages
                console.log(`[WebsiteScraper] Skipping ${pageUrl}: ${err.message}`);
            }
        }
        
        // Convert to contacts
        for (const email of results.emails) {
            results.contacts.push({
                email,
                source: 'websiteScraperMiner',
                sourceUrl: url,
                phone: results.phones.size > 0 ? Array.from(results.phones)[0] : null,
                evidence: createEvidence(EVIDENCE_TYPES.TEXT_MATCH, {
                    foundOn: 'company_website',
                    pattern: 'email_regex'
                })
            });
        }
        
        return {
            status: results.contacts.length > 0 ? 'SUCCESS' : 'PARTIAL',
            contacts: results.contacts,
            emails: Array.from(results.emails),
            meta: {
                source: 'websiteScraperMiner',
                pages_crawled: results.pages_crawled,
                phones_found: results.phones.size
            }
        };
        
    } finally {
        if (browser) await browser.close();
    }
}

/**
 * Create Website Scraper Miner Adapter
 * @returns {BaseMinerAdapter}
 */
function createWebsiteScraperMinerAdapter() {
    const minerFn = async (job) => {
        const costTracker = getCostTracker();
        const websiteUrl = job.input;
        
        // Pre-check cost
        const canProceed = costTracker.canProceed(
            job.id,
            'DEEP_CRAWL_PAGE',
            websiteUrl
        );
        
        if (!canProceed.allowed) {
            return {
                status: 'COST_LIMIT',
                emails: [],
                contacts: [],
                meta: { error: canProceed.reason }
            };
        }
        
        try {
            // Scrape the website
            const result = await scrapeWebsite(websiteUrl, {
                maxPages: job.config?.max_deep_crawl_pages || 3,
                timeout: 30000
            });
            
            // Record cost per page crawled
            const pagesCrawled = result.meta?.pages_crawled || 1;
            for (let i = 0; i < pagesCrawled; i++) {
                costTracker.recordCost(job.id, 'DEEP_CRAWL_PAGE', websiteUrl);
            }
            
            // Record success
            if (result.contacts.length > 0) {
                costTracker.recordSuccess(websiteUrl);
            }
            
            return result;
            
        } catch (err) {
            costTracker.recordFailure(websiteUrl, err.message);
            throw err;
        }
    };
    
    const adapter = new BaseMinerAdapter('websiteScraperMiner', minerFn, {
        description: 'Website Scraper - Deep crawl company websites for contact info',
        priority: 5,  // Flow 2 only
        timeout: 90000
    });
    
    // Website scraper NEVER uses cache - always fresh
    adapter.shouldUseCache = () => false;
    
    return adapter;
}

/**
 * Scrape multiple websites (for Flow 2 batch processing)
 * @param {Array<string>} urls - Website URLs to scrape
 * @param {string} jobId - Job ID for cost tracking
 * @param {Object} options - Scraping options
 * @returns {Promise<Array>}
 */
async function scrapeMultipleWebsites(urls, jobId, options = {}) {
    const costTracker = getCostTracker();
    const results = [];
    const maxConcurrent = options.maxConcurrent || 3;
    
    // Process in batches
    for (let i = 0; i < urls.length; i += maxConcurrent) {
        const batch = urls.slice(i, i + maxConcurrent);
        
        const batchPromises = batch.map(async (url) => {
            // Check cost before each scrape
            const canProceed = costTracker.canProceed(jobId, 'DEEP_CRAWL_PAGE', url);
            
            if (!canProceed.allowed) {
                return {
                    url,
                    status: 'SKIPPED',
                    reason: canProceed.reason
                };
            }
            
            try {
                const result = await scrapeWebsite(url, {
                    maxPages: options.maxPagesPerSite || 3,
                    timeout: 30000
                });
                
                // Record cost
                const pagesCrawled = result.meta?.pages_crawled || 1;
                for (let j = 0; j < pagesCrawled; j++) {
                    costTracker.recordCost(jobId, 'DEEP_CRAWL_PAGE', url);
                }
                
                return {
                    url,
                    ...result
                };
                
            } catch (err) {
                costTracker.recordFailure(url, err.message);
                return {
                    url,
                    status: 'ERROR',
                    error: err.message
                };
            }
        });
        
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
        
        // Small delay between batches
        if (i + maxConcurrent < urls.length) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    
    return results;
}

module.exports = {
    createWebsiteScraperMinerAdapter,
    scrapeWebsite,
    scrapeMultipleWebsites
};
