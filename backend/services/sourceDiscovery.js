/**
 * Source Discovery Engine v1.0
 *
 * Uses Claude API with web_search tool to find B2B data sources
 * (association member lists, industry directories, fair exhibitor pages)
 * based on fair name, industry, and target countries.
 *
 * Input:  { fair_name, industry, target_countries: [], organizer_id }
 * Output: { sources: [{ url, source_type, estimated_companies, has_email_on_page, language, notes }] }
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 60000;

/**
 * Discover data sources for a trade fair
 *
 * @param {Object} params
 * @param {string} params.fair_name - Trade fair name
 * @param {string} params.industry - Industry/sector
 * @param {string[]} params.target_countries - Target countries
 * @param {string} params.organizer_id - Organizer ID (for logging)
 * @returns {Promise<Object>} { sources: [...] }
 */
async function discoverSources({ fair_name, industry, target_countries = [], organizer_id }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[sourceDiscovery] ANTHROPIC_API_KEY not configured');
    return { sources: [], error: 'ANTHROPIC_API_KEY not configured' };
  }

  console.log(`[sourceDiscovery] Starting discovery: fair="${fair_name}", industry="${industry}", countries="${target_countries.join(', ')}"`);

  const systemPrompt = 'You are a B2B data sourcing expert for trade fair organizers. Your job is to find URLs that contain lists of companies in specific industries. You must use web_search to find real, working URLs — do not invent URLs.';

  const userPrompt = `Find 15-20 real URLs containing company lists for the following trade fair:

Fair: ${fair_name}
Industry: ${industry}
Target countries: ${target_countries.join(', ')}

Search for:
1. Industry association member lists
2. Exhibitor lists from related trade fairs
3. Business directories with contact info
4. PDF membership lists from industry bodies
5. Chamber of commerce or government registries

For each URL return JSON with these fields:
- url (must be real, verify with search)
- source_type: 'association' | 'directory' | 'fair' | 'pdf' | 'registry' | 'other'
- estimated_companies: number (estimate)
- has_email_on_page: true | false | 'unknown'
- language: language of the page
- notes: one sentence why this is relevant

Return a JSON array only. No markdown, no explanation, no code fences.`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16000,
        system: systemPrompt,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: userPrompt }]
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[sourceDiscovery] API error ${response.status}: ${errorText}`);
      return { sources: [], error: `API error: ${response.status}` };
    }

    const data = await response.json();

    // Extract text content from response
    let textContent = '';
    if (data.content && Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text') {
          textContent += block.text;
        }
      }
    }

    if (!textContent) {
      console.log('[sourceDiscovery] No text content in response');
      return { sources: [] };
    }

    // Parse JSON from response
    const sources = parseSourcesFromText(textContent);
    console.log(`[sourceDiscovery] Found ${sources.length} sources`);

    return { sources };
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[sourceDiscovery] Request timed out');
      return { sources: [], error: 'Request timed out' };
    }
    console.error(`[sourceDiscovery] Error: ${err.message}`);
    return { sources: [], error: err.message };
  }
}

/**
 * Parse JSON array of sources from Claude's text response
 * Handles various response formats (with/without code fences, mixed text)
 */
function parseSourcesFromText(text) {
  // Try direct parse first
  try {
    const parsed = JSON.parse(text.trim());
    if (Array.isArray(parsed)) return validateSources(parsed);
  } catch (e) {}

  // Try extracting JSON from code fences
  const codeFenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeFenceMatch) {
    try {
      const parsed = JSON.parse(codeFenceMatch[1].trim());
      if (Array.isArray(parsed)) return validateSources(parsed);
    } catch (e) {}
  }

  // Try finding JSON array in text
  const arrayMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) return validateSources(parsed);
    } catch (e) {}
  }

  console.log('[sourceDiscovery] Could not parse sources from response');
  return [];
}

/**
 * Validate and clean source objects
 */
function validateSources(sources) {
  const validTypes = ['association', 'directory', 'fair', 'pdf', 'registry', 'other'];

  return sources
    .filter(s => s && typeof s === 'object' && s.url && typeof s.url === 'string')
    .map(s => ({
      url: s.url,
      source_type: validTypes.includes(s.source_type) ? s.source_type : 'other',
      estimated_companies: typeof s.estimated_companies === 'number' ? s.estimated_companies : 0,
      has_email_on_page: s.has_email_on_page === true ? true : s.has_email_on_page === false ? false : 'unknown',
      language: s.language || 'unknown',
      notes: typeof s.notes === 'string' ? s.notes.slice(0, 500) : ''
    }));
}

module.exports = { discoverSources };
