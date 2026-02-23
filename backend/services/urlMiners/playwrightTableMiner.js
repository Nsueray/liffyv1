/**
 * Playwright Table Miner
 * Extracts data from single-page sites where all info is in tables/lists
 * 
 * Use cases:
 * - Distributor lists
 * - Member directories
 * - Contact tables
 * - Any page where data is NOT in detail pages but directly visible
 * 
 * Does NOT follow detail links - extracts everything from current page
 */

const { chromium } = require('playwright');
const { extractAllEmails } = require('./cloudflareDecoder');

// Phone regex patterns for various formats
const PHONE_PATTERNS = [
    /(?:\+?[\d\s\-().]{7,20})/g,
    /\b0[789][01]\d{8}\b/g,  // Nigerian mobile
    /\b0[1-9]\d{6,9}\b/g,    // Nigerian landline
];

/**
 * Extract phone numbers from text
 */
function extractPhones(text) {
    if (!text) return [];
    
    const phones = new Set();
    
    for (const pattern of PHONE_PATTERNS) {
        const matches = text.match(pattern) || [];
        for (const match of matches) {
            const cleaned = match.replace(/[\s\-().]/g, '');
            if (cleaned.length >= 7 && cleaned.length <= 15) {
                // Filter out years and other numbers
                if (!/^(19|20)\d{2}$/.test(cleaned)) {
                    phones.add(cleaned);
                }
            }
        }
    }
    
    return Array.from(phones);
}

/**
 * Extract website URLs from text/HTML
 */
function extractWebsites(html, baseUrl) {
    if (!html) return [];
    
    const websites = new Set();
    let baseHost = '';
    
    try {
        baseHost = new URL(baseUrl).hostname;
    } catch (e) {}
    
    // Pattern: href="http..." or https://...
    const urlPattern = /https?:\/\/(?:www\.)?([a-zA-Z0-9][-a-zA-Z0-9]*\.)+[a-zA-Z]{2,}[^\s"'<>]*/gi;
    const matches = html.match(urlPattern) || [];
    
    for (const url of matches) {
        try {
            const u = new URL(url);
            // Skip social media and the base site itself
            if (u.hostname.includes('facebook')) continue;
            if (u.hostname.includes('twitter')) continue;
            if (u.hostname.includes('linkedin')) continue;
            if (u.hostname.includes('instagram')) continue;
            if (u.hostname.includes('youtube')) continue;
            if (u.hostname === baseHost) continue;
            if (u.hostname.includes('cloudflare')) continue;
            if (u.hostname.includes('safelinks')) continue;
            
            websites.add(u.origin);
        } catch (e) {}
    }
    
    return Array.from(websites);
}

/**
 * Parse table rows into structured data
 */
async function parseTableData(page) {
    return await page.evaluate(() => {
        const results = [];
        
        // Strategy 1: Look for HTML tables
        const tables = document.querySelectorAll('table');
        for (const table of tables) {
            const rows = table.querySelectorAll('tr');
            for (const row of rows) {
                const cells = row.querySelectorAll('td, th');
                if (cells && cells.length >= 2) {
                    const cellTexts = Array.from(cells).map(c => c.innerHTML);
                    results.push({
                        type: 'table_row',
                        html: row.innerHTML,
                        text: row.innerText,
                        cells: cellTexts
                    });
                }
            }
        }
        
        // Strategy 2: Look for card/list patterns
        const cardSelectors = [
            '.card', '.item', '.member', '.distributor', '.contact',
            '[class*="card"]', '[class*="item"]', '[class*="member"]',
            'article', '.entry', '.listing'
        ];
        
        for (const selector of cardSelectors) {
            const cards = document.querySelectorAll(selector);
            for (const card of cards) {
                if (card && card.innerText && card.innerText.length > 20) {
                    results.push({
                        type: 'card',
                        html: card.innerHTML,
                        text: card.innerText
                    });
                }
            }
        }
        
        // Strategy 3: Look for definition lists
        const dlists = document.querySelectorAll('dl');
        for (const dl of dlists) {
            results.push({
                type: 'definition_list',
                html: dl.innerHTML,
                text: dl.innerText
            });
        }
        
        // Strategy 4: Bold label patterns (Label: Value)
        const allText = document.body.innerText;
        const blocks = allText.split(/\n\n+/);
        for (const block of blocks) {
            if (block.includes('@') || block.toLowerCase().includes('phone') || block.toLowerCase().includes('email')) {
                results.push({
                    type: 'text_block',
                    html: '',
                    text: block
                });
            }
        }
        
        return results;
    });
}

/**
 * Extract structured contact from a data block
 */
function extractContactFromBlock(block, allEmails, allPhones, allWebsites) {
    const text = block.text || '';
    const html = block.html || '';
    
    // Find emails in this block
    const blockEmails = extractAllEmails(html) || [];
    const textEmails = extractAllEmails(text) || [];
    const emails = [...new Set([...blockEmails, ...textEmails])];
    
    if (emails.length === 0) return null;
    
    // Find phones in this block
    const phones = extractPhones(text);
    
    // Try to extract company name
    let companyName = null;
    
    // Look for bold/strong text as company name
    const boldMatch = html.match(/<(?:strong|b)[^>]*>([^<]+)<\/(?:strong|b)>/i);
    if (boldMatch) {
        companyName = boldMatch[1].trim();
    }
    
    // Or first line if it looks like a name
    if (!companyName) {
        const lines = text.split('\n').filter(l => l.trim());
        if (lines[0] && lines[0].length < 100 && !lines[0].includes('@')) {
            companyName = lines[0].trim();
        }
    }
    
    // Extract address (lines with common address keywords)
    let address = null;
    const addressKeywords = ['address', 'street', 'road', 'avenue', 'plot', 'no.', 'no ', 'state', 'city'];
    const lines = text.split('\n');
    for (const line of lines) {
        const lower = line.toLowerCase();
        if (addressKeywords.some(kw => lower.includes(kw))) {
            address = line.trim();
            break;
        }
    }
    
    // Extract website from block
    const blockWebsites = extractWebsites(html, '');
    
    return {
        companyName,
        emails,
        phones: phones.slice(0, 3), // Max 3 phones
        address,
        website: blockWebsites[0] || null,
        raw: text.substring(0, 500)
    };
}

/**
 * Main mining function
 * @param {Object} job - Mining job object
 * @returns {Object} - ScrapeResult format
 */
async function mine(job) {
    const url = job.input;
    const config = job.config || {};
    
    console.log(`[TableMiner] Starting for: ${url}`);
    
    let browser;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage']
        });
        
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 },
            ignoreHTTPSErrors: true
        });
        
        const page = await context.newPage();
        
        // Navigate
        const response = await page.goto(url, {
            waitUntil: 'networkidle',
            timeout: 30000
        });
        
        // Check for blocks
        if (response && [403, 401, 429].includes(response.status())) {
            console.log(`[TableMiner] HTTP ${response.status()} - might be blocked`);
            return {
                status: 'BLOCKED',
                emails: [],
                contacts: [],
                extracted_links: [],
                http_code: response.status(),
                meta: { source: 'tableMiner', error: `HTTP ${response.status()}` }
            };
        }
        
        // Wait for content to load
        await page.waitForTimeout(2000);
        
        // Scroll to trigger lazy loading
        await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
        });
        await page.waitForTimeout(1000);
        
        // Get full HTML
        const html = await page.content();
        
        // Extract all emails from entire page (including CF protected)
        const allEmails = extractAllEmails(html);
        console.log(`[TableMiner] Found ${allEmails.length} emails on page`);
        
        if (allEmails.length === 0) {
            return {
                status: 'PARTIAL',
                emails: [],
                contacts: [],
                extracted_links: [],
                http_code: response?.status() || 200,
                meta: { source: 'tableMiner', note: 'No emails found on page' }
            };
        }
        
        // Extract all phones and websites
        const pageText = await page.evaluate(() => document.body.innerText);
        const allPhones = extractPhones(pageText);
        const allWebsites = extractWebsites(html, url);
        
        // Parse structured data blocks
        const dataBlocks = await parseTableData(page);
        console.log(`[TableMiner] Found ${dataBlocks.length} data blocks`);
        
        // Extract contacts from blocks
        const contacts = [];
        const usedEmails = new Set();
        
        for (const block of dataBlocks) {
            const contact = extractContactFromBlock(block, allEmails, allPhones, allWebsites);
            if (contact && contact.emails.length > 0) {
                // Avoid duplicates
                const newEmails = contact.emails.filter(e => !usedEmails.has(e));
                if (newEmails.length > 0) {
                    contact.emails = newEmails;
                    newEmails.forEach(e => usedEmails.add(e));
                    contacts.push(contact);
                }
            }
        }
        
        // If we found emails but couldn't structure them, create basic contacts
        if (contacts.length === 0 && allEmails.length > 0) {
            for (const email of allEmails) {
                contacts.push({
                    companyName: null,
                    emails: [email],
                    phones: [],
                    address: null,
                    website: null,
                    raw: null
                });
            }
        }
        
        console.log(`[TableMiner] Extracted ${contacts.length} contacts`);
        
        return {
            status: contacts.length > 0 ? 'SUCCESS' : 'PARTIAL',
            emails: allEmails,
            contacts: contacts,
            extracted_links: [],
            http_code: response?.status() || 200,
            meta: {
                source: 'tableMiner',
                total_emails: allEmails.length,
                total_contacts: contacts.length,
                total_phones: allPhones.length,
                total_websites: allWebsites.length
            }
        };
        
    } catch (err) {
        console.log(`[TableMiner] Error: ${err.message}`);
        
        if (err.message.includes('BLOCK') || err.message.includes('403')) {
            return {
                status: 'BLOCKED',
                emails: [],
                contacts: [],
                extracted_links: [],
                http_code: 403,
                meta: { source: 'tableMiner', error: err.message }
            };
        }
        
        return {
            status: 'ERROR',
            emails: [],
            contacts: [],
            extracted_links: [],
            http_code: null,
            meta: { source: 'tableMiner', error: err.message }
        };
        
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = { mine };
