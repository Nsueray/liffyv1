/**
 * AI Miner - Claude API Powered Data Extraction
 * 
 * Uses Claude 3 Haiku for intelligent contact extraction
 * Handles: tables, cards, lists, any messy HTML
 * 
 * Returns perfectly structured JSON every time
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
 */
async function extractDataBlocks(page) {
    return await page.evaluate(() => {
        const blocks = [];
        
        // Strategy 1: Table cells (most common for distributor lists)
        const tables = document.querySelectorAll('table');
        for (const table of tables) {
            const cells = table.querySelectorAll('td');
            for (const cell of cells) {
                const text = cell.innerText.trim();
                // Only if it looks like contact info
                if (text.length > 50 && (text.includes('@') || text.toLowerCase().includes('address') || text.toLowerCase().includes('phone'))) {
                    blocks.push({
                        type: 'table_cell',
                        text: text,
                        html: cell.innerHTML
                    });
                }
            }
        }
        
        // Strategy 2: Cards/Divs with contact patterns
        if (blocks.length === 0) {
            const cardSelectors = [
                '.card', '.contact', '.member', '.distributor', '.company',
                '[class*="card"]', '[class*="contact"]', '[class*="item"]',
                'article', '.entry', '.profile'
            ];
            
            for (const selector of cardSelectors) {
                const cards = document.querySelectorAll(selector);
                for (const card of cards) {
                    const text = card.innerText.trim();
                    if (text.length > 50 && text.length < 2000 && text.includes('@')) {
                        blocks.push({
                            type: 'card',
                            text: text,
                            html: card.innerHTML
                        });
                    }
                }
            }
        }
        
        // Strategy 3: Any element containing email
        if (blocks.length === 0) {
            const allElements = document.querySelectorAll('div, section, article, li');
            for (const el of allElements) {
                const text = el.innerText.trim();
                if (text.length > 30 && text.length < 1500 && text.includes('@')) {
                    // Check it's not a parent of already found blocks
                    const hasEmailChild = el.querySelector('a[href^="mailto:"]');
                    if (hasEmailChild || text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)) {
                        blocks.push({
                            type: 'element',
                            text: text,
                            html: el.innerHTML
                        });
                    }
                }
            }
        }
        
        // Deduplicate (remove blocks that are subsets of others)
        const unique = [];
        for (const block of blocks) {
            const isDuplicate = unique.some(b => 
                b.text.includes(block.text) || block.text.includes(b.text)
            );
            if (!isDuplicate) {
                unique.push(block);
            }
        }
        
        return unique.slice(0, 50); // Max 50 blocks per page
    });
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
            // Try direct parse
            json = JSON.parse(response);
        } catch {
            // Try to extract JSON from response
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
 */
async function mine(job) {
    const url = job.input;
    console.log(`[AIMiner] Starting for: ${url}`);
    
    // Check API key
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
        
        if (response && [403, 401, 429].includes(response.status())) {
            return {
                status: 'BLOCKED',
                emails: [],
                contacts: [],
                extracted_links: [],
                http_code: response.status(),
                meta: { source: 'aiMiner', error: `HTTP ${response.status()}` }
            };
        }
        
        // Wait for dynamic content
        await page.waitForTimeout(2000);
        
        // Scroll to load lazy content
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1000);
        
        // Extract data blocks
        console.log('[AIMiner] Extracting data blocks...');
        const blocks = await extractDataBlocks(page);
        console.log(`[AIMiner] Found ${blocks.length} data blocks`);
        
        if (blocks.length === 0) {
            return {
                status: 'PARTIAL',
                emails: [],
                contacts: [],
                extracted_links: [],
                http_code: response?.status() || 200,
                meta: { source: 'aiMiner', note: 'No data blocks found on page' }
            };
        }
        
        // Extract contacts using AI
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
            extracted_links: [],
            http_code: response?.status() || 200,
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
