/**
 * AI Miner v2 - Claude API Powered Data Extraction
 * 
 * CHANGELOG v2:
 * - Added null checks to fix "Cannot read properties of undefined" errors
 * - Added WordPress member directory support (as fallback, doesn't change existing logic)
 * - Added profile page crawling (only when main page has no blocks)
 * - Added detailed logging
 * 
 * Original TotalEnergies logic is PRESERVED
 */

const { chromium } = require('playwright');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-3-haiku-20240307';

/**
 * Call Claude API
 */
async function callClaude(prompt, systemPrompt) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    
    if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY not configured');
    }
    
    const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: MODEL,
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: 'user', content: prompt }]
        })
    });
    
    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Claude API error: ${response.status} - ${error}`);
    }
    
    const data = await response.json();
    return data.content[0].text;
}

/**
 * Extract data blocks from page (tables, cards, sections)
 * PRESERVED: Original logic that worked for TotalEnergies
 * ADDED: Null checks and WordPress fallback
 */
async function extractDataBlocks(page, sourceUrl) {
    return await page.evaluate((url) => {
        const blocks = [];
        const debug = [];
        
        // === HELPER FUNCTIONS (NEW - for null safety) ===
        const safeText = (el) => {
            try {
                return (el && el.innerText) ? el.innerText.trim() : '';
            } catch (e) {
                return '';
            }
        };
        
        const safeHtml = (el) => {
            try {
                return (el && el.innerHTML) ? el.innerHTML : '';
            } catch (e) {
                return '';
            }
        };
        
        debug.push(`Page: ${document.title || 'No title'}`);
        
        // === STRATEGY 1: Table cells (ORIGINAL - PRESERVED) ===
        const tables = document.querySelectorAll('table');
        debug.push(`Tables found: ${tables.length}`);
        
        for (const table of tables) {
            const cells = table.querySelectorAll('td');
            for (const cell of cells) {
                const text = safeText(cell); // Changed: Added null check
                if (text && text.length > 50 && (text.includes('@') || text.toLowerCase().includes('address') || text.toLowerCase().includes('phone'))) {
                    blocks.push({
                        type: 'table_cell',
                        text: text,
                        html: safeHtml(cell)
                    });
                }
            }
        }
        debug.push(`Blocks from tables: ${blocks.length}`);
        
        // === STRATEGY 2: Cards/Divs (ORIGINAL - PRESERVED, just added null checks) ===
        if (blocks.length === 0) {
            const cardSelectors = [
                '.card', '.contact', '.member', '.distributor', '.company',
                '[class*="card"]', '[class*="contact"]', '[class*="item"]',
                'article', '.entry', '.profile'
            ];
            
            for (const selector of cardSelectors) {
                try {
                    const cards = document.querySelectorAll(selector);
                    for (const card of cards) {
                        const text = safeText(card); // Changed: Added null check
                        if (text && text.length > 50 && text.length < 2000 && text.includes('@')) {
                            blocks.push({
                                type: 'card',
                                text: text,
                                html: safeHtml(card)
                            });
                        }
                    }
                } catch (e) {
                    // Selector failed, continue
                }
            }
        }
        debug.push(`Blocks after cards: ${blocks.length}`);
        
        // === STRATEGY 3: Generic email containers (ORIGINAL - PRESERVED) ===
        if (blocks.length === 0) {
            const allElements = document.querySelectorAll('div, section, article, li');
            for (const el of allElements) {
                const text = safeText(el); // Changed: Added null check
                if (text && text.length > 30 && text.length < 1500 && text.includes('@')) {
                    const hasEmailChild = el.querySelector('a[href^="mailto:"]');
                    if (hasEmailChild || text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)) {
                        blocks.push({
                            type: 'element',
                            text: text,
                            html: safeHtml(el)
                        });
                    }
                }
            }
        }
        debug.push(`Blocks after generic: ${blocks.length}`);
        
        // === STRATEGY 4: WordPress Member Directories (NEW - FALLBACK ONLY) ===
        if (blocks.length === 0) {
            const wpSelectors = [
                '.wppb-user-listing li',
                '.um-members .um-member',
                '.bp-user',
                '[class*="member-list"] .member',
                '[class*="user-list"] .user',
                '.directory-list li'
            ];
            
            for (const selector of wpSelectors) {
                try {
                    const items = document.querySelectorAll(selector);
                    for (const item of items) {
                        const text = safeText(item);
                        if (text && text.length > 20) {
                            blocks.push({
                                type: 'wp_member',
                                text: text,
                                html: safeHtml(item)
                            });
                        }
                    }
                } catch (e) {}
            }
            debug.push(`Blocks after WordPress: ${blocks.length}`);
        }
        
        // === PROFILE LINK DETECTION (NEW - for crawling fallback) ===
        const profileLinks = [];
        try {
            const links = document.querySelectorAll('a[href]');
            for (const link of links) {
                const href = link.getAttribute('href') || '';
                if (href.match(/\/(member|profile|user|author)\/[^\/]+/i)) {
                    try {
                        const fullUrl = new URL(href, url).href;
                        if (!profileLinks.includes(fullUrl)) {
                            profileLinks.push(fullUrl);
                        }
                    } catch (e) {}
                }
            }
        } catch (e) {}
        debug.push(`Profile links found: ${profileLinks.length}`);
        
        // Return more profile links (increased from 20 to 40)
        const maxProfileLinks = 40;
        
        // === DEDUPLICATION (ORIGINAL - PRESERVED) ===
        const unique = [];
        for (const block of blocks) {
            if (!block.text) continue; // Added null check
            const isDuplicate = unique.some(b => 
                b.text && (b.text.includes(block.text) || block.text.includes(b.text))
            );
            if (!isDuplicate) {
                unique.push(block);
            }
        }
        
        debug.push(`Final unique blocks: ${unique.length}`);
        
        return {
            blocks: unique.slice(0, 50),
            profileLinks: profileLinks.slice(0, maxProfileLinks),
            debug: debug
        };
    }, sourceUrl);
}

/**
 * Crawl a single profile page for contact info (NEW)
 */
async function crawlProfilePage(page, profileUrl) {
    try {
        console.log(`[AIMiner] 📄 Crawling profile: ${profileUrl}`);
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(1000);
        
        const content = await page.evaluate(() => {
            const text = document.body?.innerText || '';
            return text.substring(0, 3000);
        });
        
        if (content && content.includes('@')) {
            return { url: profileUrl, text: content };
        }
    } catch (err) {
        console.log(`[AIMiner] Profile error: ${err.message}`);
    }
    return null;
}

/**
 * Use Claude to extract structured contact from text block
 * PRESERVED: Original logic
 */
async function extractContactWithAI(blockText) {
    const systemPrompt = `You are a data extraction specialist. Extract contact information from the given text and return ONLY valid JSON.

Rules:
- Extract ALL fields you can find
- If a field is not present, use null
- For phone numbers, keep original format
- Company name is usually the first line or in bold
- Return ONLY the JSON object, no explanation

IMPORTANT for location fields:
- country: ONLY the country name (e.g., "Nigeria", "USA", "UK"). Never put state/city here.
- state: The state/province/region (e.g., "Kano State", "Lagos State", "California")
- city: The city name only (e.g., "Kano", "Lagos", "Abuja")
- If address contains "Kano State, Nigeria", then country="Nigeria", state="Kano State", city="Kano"

IMPORTANT for website:
- Only extract actual company websites, not the source page URL
- If no company website is mentioned, use null

JSON Schema:
{
  "company_name": "string or null",
  "contact_name": "string or null", 
  "job_title": "string or null",
  "email": "string or null",
  "phone": "string or null (multiple phones comma separated)",
  "address": "string or null (full address)",
  "city": "string or null (city name only)",
  "state": "string or null (state/province name)", 
  "country": "string or null (ONLY country name like Nigeria, USA, UK)",
  "website": "string or null (company website only, not source URL)"
}`;

    const prompt = `Extract contact information from this text:\n\n${blockText}`;
    
    try {
        const response = await callClaude(prompt, systemPrompt);
        
        let json;
        try {
            json = JSON.parse(response);
        } catch {
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                json = JSON.parse(jsonMatch[0]);
            } else {
                console.log('[AI] Could not parse JSON from response');
                return null;
            }
        }
        
        return json;
    } catch (err) {
        console.log(`[AI] Extraction error: ${err.message}`);
        return null;
    }
}

/**
 * Main mining function
 * PRESERVED: Original flow
 * ADDED: Profile crawling fallback, detailed logging
 */
async function mine(job) {
    const url = job.input;
    console.log(`[AIMiner] Starting for: ${url}`);
    
    if (!process.env.ANTHROPIC_API_KEY) {
        console.log('[AIMiner] ERROR: ANTHROPIC_API_KEY not set');
        return {
            status: 'ERROR',
            emails: [],
            contacts: [],
            extracted_links: [],
            http_code: null,
            meta: { source: 'aiMiner', error: 'ANTHROPIC_API_KEY not configured' }
        };
    }
    
    let browser;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage']
        });
        
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 }
        });
        
        const page = await context.newPage();
        
        // Navigate (PRESERVED)
        console.log('[AIMiner] Loading page...');
        const response = await page.goto(url, {
            waitUntil: 'networkidle',
            timeout: 30000
        });
        
        const httpCode = response?.status() || 200;
        console.log(`[AIMiner] HTTP Status: ${httpCode}`);
        
        if ([403, 401, 429].includes(httpCode)) {
            return {
                status: 'BLOCKED',
                emails: [],
                contacts: [],
                extracted_links: [],
                http_code: httpCode,
                meta: { source: 'aiMiner', error: `HTTP ${httpCode}` }
            };
        }
        
        // Wait for dynamic content (PRESERVED)
        await page.waitForTimeout(2000);
        
        // Scroll to load lazy content (PRESERVED)
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1000);
        
        // Extract data blocks (UPDATED with safe version)
        console.log('[AIMiner] Extracting data blocks...');
        const extraction = await extractDataBlocks(page, url);
        
        // Log debug info (NEW)
        console.log('[AIMiner] === Debug ===');
        extraction.debug.forEach(line => console.log(`[AIMiner] ${line}`));
        console.log('[AIMiner] =============');
        
        let blocks = extraction.blocks;
        const profileLinks = extraction.profileLinks;
        
        console.log(`[AIMiner] Found ${blocks.length} data blocks`);
        
        // NEW: If few blocks but many profile links, likely need to crawl profiles
        // This won't affect TotalEnergies (19 blocks) but will help PWDA (1 block, 45 links)
        if (blocks.length < 3 && profileLinks.length > 5) {
            console.log(`[AIMiner] Few blocks (${blocks.length}) but many profile links (${profileLinks.length}), crawling profiles...`);
            
            const crawledBlocks = [];
            const maxCrawl = 30; // Increased from 15
            
            for (let i = 0; i < Math.min(profileLinks.length, maxCrawl); i++) {
                const profileData = await crawlProfilePage(page, profileLinks[i]);
                if (profileData) {
                    crawledBlocks.push({
                        type: 'profile_page',
                        text: profileData.text,
                        html: ''
                    });
                }
            }
            
            if (crawledBlocks.length > 0) {
                console.log(`[AIMiner] Crawled ${crawledBlocks.length} profiles with content`);
                // Add crawled blocks to existing blocks
                blocks = [...blocks, ...crawledBlocks];
            }
        }
        
        // Original fallback: If still no blocks but profile links exist
        if (blocks.length === 0 && profileLinks.length > 0) {
            console.log(`[AIMiner] No blocks found, trying ${profileLinks.length} profile links...`);
            
            for (let i = 0; i < Math.min(profileLinks.length, 30); i++) {
                const profileData = await crawlProfilePage(page, profileLinks[i]);
                if (profileData) {
                    blocks.push({
                        type: 'profile_page',
                        text: profileData.text,
                        html: ''
                    });
                }
            }
            console.log(`[AIMiner] Crawled ${blocks.length} profiles with content`);
        }
        
        if (blocks.length === 0) {
            return {
                status: 'PARTIAL',
                emails: [],
                contacts: [],
                extracted_links: profileLinks,
                http_code: httpCode,
                meta: { source: 'aiMiner', note: 'No data blocks found on page' }
            };
        }
        
        // Extract contacts using AI (PRESERVED)
        console.log('[AIMiner] Processing with Claude AI...');
        const contacts = [];
        const emails = new Set();
        
        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            console.log(`[AIMiner] Processing block ${i + 1}/${blocks.length}...`);
            
            const extracted = await extractContactWithAI(block.text);
            
            if (extracted && extracted.email) {
                contacts.push({
                    companyName: extracted.company_name,
                    contactName: extracted.contact_name,
                    jobTitle: extracted.job_title,
                    email: extracted.email,
                    phone: extracted.phone,
                    address: extracted.address,
                    city: extracted.city,
                    state: extracted.state,
                    country: extracted.country,
                    website: extracted.website,
                    emails: [extracted.email]
                });
                emails.add(extracted.email.toLowerCase());
                
                console.log(`[AIMiner] ✅ ${extracted.company_name || 'Unknown'} - ${extracted.email}`);
            }
            
            if (i < blocks.length - 1) {
                await new Promise(r => setTimeout(r, 100));
            }
        }
        
        console.log(`[AIMiner] Extracted ${contacts.length} contacts with ${emails.size} unique emails`);
        
        return {
            status: contacts.length > 0 ? 'SUCCESS' : 'PARTIAL',
            emails: Array.from(emails),
            contacts: contacts,
            extracted_links: profileLinks,
            http_code: httpCode,
            meta: {
                source: 'aiMiner',
                model: MODEL,
                blocks_processed: blocks.length,
                total_contacts: contacts.length,
                total_emails: emails.size
            }
        };
        
    } catch (err) {
        console.log(`[AIMiner] Error: ${err.message}`);
        
        if (err.message.includes('BLOCK') || err.message.includes('403')) {
            return {
                status: 'BLOCKED',
                emails: [],
                contacts: [],
                extracted_links: [],
                http_code: 403,
                meta: { source: 'aiMiner', error: err.message }
            };
        }
        
        return {
            status: 'ERROR',
            emails: [],
            contacts: [],
            extracted_links: [],
            http_code: null,
            meta: { source: 'aiMiner', error: err.message }
        };
        
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = { mine };
