/**
 * AI Miner v2 - Claude API Powered Data Extraction
 * 
 * Features:
 * - Claude 3 Haiku for intelligent extraction
 * - Multiple detection strategies
 * - WordPress member directory support
 * - Detailed logging for debugging
 * - Robust null checking
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
 * Extract data blocks from page with detailed logging
 */
async function extractDataBlocks(page, url) {
    return await page.evaluate((sourceUrl) => {
        const blocks = [];
        const log = [];
        
        // Helper: Safe text extraction
        const getText = (el) => {
            try {
                return (el?.innerText || el?.textContent || '').trim();
            } catch {
                return '';
            }
        };
        
        // Helper: Safe HTML extraction
        const getHtml = (el) => {
            try {
                return el?.innerHTML || '';
            } catch {
                return '';
            }
        };
        
        // Log page info
        log.push(`Page title: ${document.title}`);
        log.push(`Body length: ${document.body?.innerText?.length || 0} chars`);
        
        // Strategy 1: Table cells
        const tables = document.querySelectorAll('table');
        log.push(`Strategy 1 - Tables found: ${tables.length}`);
        
        for (const table of tables) {
            const cells = table.querySelectorAll('td');
            for (const cell of cells) {
                const text = getText(cell);
                if (text.length > 50 && (text.includes('@') || text.toLowerCase().includes('address') || text.toLowerCase().includes('phone'))) {
                    blocks.push({
                        type: 'table_cell',
                        text: text,
                        html: getHtml(cell)
                    });
                }
            }
        }
        log.push(`Strategy 1 - Blocks from tables: ${blocks.length}`);
        
        // Strategy 2: Cards/Divs with contact patterns
        const cardSelectors = [
            '.card', '.contact', '.member', '.distributor', '.company',
            '[class*="card"]', '[class*="contact"]', '[class*="member"]',
            '[class*="profile"]', '[class*="user"]', '[class*="author"]',
            'article', '.entry', '.listing', '.item'
        ];
        
        let cardCount = 0;
        for (const selector of cardSelectors) {
            try {
                const cards = document.querySelectorAll(selector);
                for (const card of cards) {
                    const text = getText(card);
                    if (text.length > 30 && text.length < 3000) {
                        // Check if contains email or contact info
                        const hasEmail = text.includes('@') || text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
                        const hasPhone = text.match(/[\d\s\-+()]{7,}/);
                        const hasContactKeywords = /email|phone|tel|mobile|contact|address/i.test(text);
                        
                        if (hasEmail || (hasPhone && hasContactKeywords)) {
                            // Check not already captured
                            const isDupe = blocks.some(b => b.text === text || b.text.includes(text) || text.includes(b.text));
                            if (!isDupe) {
                                blocks.push({
                                    type: 'card',
                                    selector: selector,
                                    text: text,
                                    html: getHtml(card)
                                });
                                cardCount++;
                            }
                        }
                    }
                }
            } catch (e) {
                // Selector failed, continue
            }
        }
        log.push(`Strategy 2 - Blocks from cards: ${cardCount}`);
        
        // Strategy 3: WordPress Profile Builder / Member directories
        const profileSelectors = [
            '.wppb-user-listing', '.um-members', '.bp-user',
            '[class*="member-list"]', '[class*="user-list"]',
            '.directory-list', '.member-directory'
        ];
        
        let profileCount = 0;
        for (const selector of profileSelectors) {
            try {
                const items = document.querySelectorAll(selector + ' li, ' + selector + ' .item, ' + selector + ' article');
                for (const item of items) {
                    const text = getText(item);
                    if (text.length > 20 && text.length < 2000) {
                        const isDupe = blocks.some(b => b.text === text);
                        if (!isDupe) {
                            blocks.push({
                                type: 'wp_member',
                                text: text,
                                html: getHtml(item)
                            });
                            profileCount++;
                        }
                    }
                }
            } catch (e) {}
        }
        log.push(`Strategy 3 - WordPress profiles: ${profileCount}`);
        
        // Strategy 4: Generic email containers
        if (blocks.length === 0) {
            const allElements = document.querySelectorAll('div, section, article, li, p');
            let genericCount = 0;
            
            for (const el of allElements) {
                const text = getText(el);
                if (text.length > 30 && text.length < 1500) {
                    const emailMatch = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi);
                    if (emailMatch && emailMatch.length > 0) {
                        const isDupe = blocks.some(b => 
                            b.text === text || 
                            b.text.includes(text) || 
                            text.includes(b.text)
                        );
                        if (!isDupe) {
                            blocks.push({
                                type: 'generic',
                                text: text,
                                html: getHtml(el),
                                emails_found: emailMatch.length
                            });
                            genericCount++;
                        }
                    }
                }
            }
            log.push(`Strategy 4 - Generic containers: ${genericCount}`);
        }
        
        // Strategy 5: Extract profile links for later crawling
        const profileLinks = [];
        const linkPatterns = [
            /\/member\/[^\/]+/i,
            /\/profile\/[^\/]+/i,
            /\/user\/[^\/]+/i,
            /\/author\/[^\/]+/i,
            /\?author=/i
        ];
        
        const allLinks = document.querySelectorAll('a[href]');
        for (const link of allLinks) {
            const href = link.getAttribute('href') || '';
            if (linkPatterns.some(p => p.test(href))) {
                try {
                    const fullUrl = new URL(href, sourceUrl).href;
                    if (!profileLinks.includes(fullUrl)) {
                        profileLinks.push(fullUrl);
                    }
                } catch {}
            }
        }
        log.push(`Strategy 5 - Profile links found: ${profileLinks.length}`);
        
        // Final deduplication
        const unique = [];
        const seenTexts = new Set();
        
        for (const block of blocks) {
            // Normalize text for comparison
            const normalized = block.text.replace(/\s+/g, ' ').substring(0, 200);
            if (!seenTexts.has(normalized)) {
                seenTexts.add(normalized);
                unique.push(block);
            }
        }
        
        log.push(`Final unique blocks: ${unique.length}`);
        
        return {
            blocks: unique.slice(0, 50),
            profileLinks: profileLinks.slice(0, 20),
            debug: log
        };
    }, url);
}

/**
 * Use Claude to extract structured contact from text block
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
        
        // Parse JSON from response
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
 * Crawl a profile page for contact info
 */
async function crawlProfilePage(page, profileUrl) {
    try {
        console.log(`[AIMiner] 📄 Visiting profile: ${profileUrl}`);
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(1000);
        
        const content = await page.evaluate(() => {
            const getText = (el) => (el?.innerText || el?.textContent || '').trim();
            
            // Try to find main content area
            const selectors = [
                '.profile-content', '.member-content', '.user-profile',
                '.entry-content', 'article', 'main', '.content'
            ];
            
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) {
                    const text = getText(el);
                    if (text.length > 50) return text;
                }
            }
            
            return getText(document.body).substring(0, 3000);
        });
        
        if (content && content.includes('@')) {
            return { url: profileUrl, text: content };
        }
    } catch (err) {
        console.log(`[AIMiner] Profile crawl error: ${err.message}`);
    }
    return null;
}

/**
 * Main mining function
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
        
        // Navigate
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
        
        // Wait for dynamic content
        await page.waitForTimeout(2000);
        
        // Scroll to load lazy content
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1000);
        
        // Extract data blocks with detailed logging
        console.log('[AIMiner] Extracting data blocks...');
        const extraction = await extractDataBlocks(page, url);
        
        // Log debug info
        console.log('[AIMiner] === Debug Info ===');
        for (const line of extraction.debug) {
            console.log(`[AIMiner] ${line}`);
        }
        console.log('[AIMiner] ==================');
        
        let blocks = extraction.blocks;
        const profileLinks = extraction.profileLinks;
        
        console.log(`[AIMiner] Found ${blocks.length} data blocks`);
        console.log(`[AIMiner] Found ${profileLinks.length} profile links`);
        
        // If no blocks but profile links exist, crawl them
        if (blocks.length === 0 && profileLinks.length > 0) {
            console.log('[AIMiner] No blocks on main page, crawling profile pages...');
            const crawledBlocks = [];
            
            for (let i = 0; i < Math.min(profileLinks.length, 10); i++) {
                const profileData = await crawlProfilePage(page, profileLinks[i]);
                if (profileData) {
                    crawledBlocks.push({
                        type: 'profile_page',
                        text: profileData.text,
                        html: '',
                        sourceUrl: profileData.url
                    });
                }
            }
            
            blocks = crawledBlocks;
            console.log(`[AIMiner] Crawled ${blocks.length} profile pages with content`);
        }
        
        if (blocks.length === 0) {
            console.log('[AIMiner] No extractable content found');
            return {
                status: 'PARTIAL',
                emails: [],
                contacts: [],
                extracted_links: profileLinks,
                http_code: httpCode,
                meta: { 
                    source: 'aiMiner', 
                    note: 'No data blocks found',
                    debug: extraction.debug,
                    profile_links: profileLinks.length
                }
            };
        }
        
        // Extract contacts using AI
        console.log('[AIMiner] Processing with Claude AI...');
        const contacts = [];
        const emails = new Set();
        
        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            console.log(`[AIMiner] Processing block ${i + 1}/${blocks.length} (${block.type})...`);
            
            const extracted = await extractContactWithAI(block.text);
            
            if (extracted && extracted.email) {
                const emailLower = extracted.email.toLowerCase();
                if (!emails.has(emailLower)) {
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
                    emails.add(emailLower);
                    
                    console.log(`[AIMiner] ✅ ${extracted.company_name || extracted.contact_name || 'Unknown'} - ${extracted.email}`);
                }
            } else {
                console.log(`[AIMiner] ⚠️ Block ${i + 1}: No email extracted`);
            }
            
            // Small delay to respect rate limits
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
                total_emails: emails.size,
                profile_links_found: profileLinks.length
            }
        };
        
    } catch (err) {
        console.log(`[AIMiner] Error: ${err.message}`);
        console.log(`[AIMiner] Stack: ${err.stack}`);
        
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
            meta: { source: 'aiMiner', error: err.message, stack: err.stack }
        };
        
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = { mine };
