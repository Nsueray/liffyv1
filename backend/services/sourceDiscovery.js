/**
 * Source Discovery Engine v2.1
 *
 * Uses Claude API with web_search tool to find B2B data sources.
 * v2.1: Optimized prompts (~150 words), 429 rate limit handling, domain dedup.
 *
 * Input:  { keyword, industry, target_countries: [], source_type?, organizer_id }
 *         (backward compat: fair_name accepted as alias for keyword)
 * Output: { sources: [{ url, source_type, estimated_companies, has_email_on_page, language, notes }] }
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 60000;
const MAX_PER_DOMAIN = 3;

// Source type → compact search focus (one line each)
const SOURCE_TYPE_FOCUS = {
  trade_fair: 'exhibitor list pages from trade fairs and exhibitions',
  association: 'member directory pages from industry associations and federations',
  chamber: 'member directories from chambers of commerce',
  business_directory: 'business directory listings (Kompass, Europages, industry portals)',
  company_listing: 'company catalog pages, blog listings, WordPress directory pages',
  trade_portal: 'supplier/manufacturer pages on trade portals (Alibaba, TradeFord)',
  government_trade: 'government trade databases, official exporter registries',
  custom_search: 'pages with company lists, contact info, or business directories',
};

// Source type → specific instruction to avoid wrong page types
const SOURCE_TYPE_INSTRUCTION = {
  trade_fair: 'Find exhibitor LIST pages, NOT fair homepages or event info pages.',
  association: 'Find MEMBER DIRECTORY or member list pages, NOT about/contact pages.',
  chamber: 'Find member DIRECTORY pages with company listings, NOT chamber homepages.',
  business_directory: 'Find searchable company LISTING pages with contact details.',
  company_listing: 'Find pages with actual company lists and contact info.',
  trade_portal: 'Find supplier/manufacturer listing pages with company details.',
  government_trade: 'Find official exporter/company REGISTRY pages with downloadable lists.',
  custom_search: '',
};

// Country → preferred language mapping
const COUNTRY_LANGUAGES = {
  'Turkey': 'Turkish', 'France': 'French', 'Germany': 'German',
  'Morocco': 'French', 'Algeria': 'French', 'Tunisia': 'French',
  'Nigeria': 'English', 'Ghana': 'English', 'Kenya': 'English',
  'South Africa': 'English', 'Egypt': 'Arabic', 'Libya': 'Arabic',
  'Russia': 'Russian', 'Ukraine': 'Ukrainian',
  'China': 'Chinese', 'Japan': 'Japanese', 'South Korea': 'Korean',
  'Spain': 'Spanish', 'Italy': 'Italian', 'Portugal': 'Portuguese',
  'Brazil': 'Portuguese', 'Argentina': 'Spanish', 'Mexico': 'Spanish',
  'Colombia': 'Spanish', 'Chile': 'Spanish', 'Peru': 'Spanish',
  'Saudi Arabia': 'Arabic', 'UAE': 'Arabic', 'Qatar': 'Arabic',
  'Kuwait': 'Arabic', 'Bahrain': 'Arabic', 'Oman': 'Arabic',
  'Jordan': 'Arabic', 'Iraq': 'Arabic', 'Lebanon': 'Arabic',
  'Iran': 'Persian', 'Pakistan': 'Urdu/English',
  'India': 'English', 'Bangladesh': 'Bengali/English',
  'Indonesia': 'Indonesian', 'Malaysia': 'Malay/English',
  'Thailand': 'Thai', 'Vietnam': 'Vietnamese',
  'Netherlands': 'Dutch', 'Belgium': 'Dutch/French',
  'Poland': 'Polish', 'Czech Republic': 'Czech',
  'Romania': 'Romanian', 'Hungary': 'Hungarian',
  'Greece': 'Greek', 'Serbia': 'Serbian', 'Bulgaria': 'Bulgarian',
  'Croatia': 'Croatian', 'Sweden': 'Swedish', 'Norway': 'Norwegian',
  'Denmark': 'Danish', 'Finland': 'Finnish',
};

/**
 * Discover data sources (v2.1 — optimized prompts + rate limit + dedup)
 */
async function discoverSources({ keyword, fair_name, industry, target_countries = [], source_type, organizer_id }) {
  const searchKeyword = (keyword || fair_name || '').trim();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[sourceDiscovery] ANTHROPIC_API_KEY not configured');
    return { sources: [], error: 'ANTHROPIC_API_KEY not configured' };
  }

  const resolvedSourceType = source_type || 'trade_fair';
  const searchFocus = SOURCE_TYPE_FOCUS[resolvedSourceType] || SOURCE_TYPE_FOCUS.custom_search;

  // Build compact search line
  const parts = [searchKeyword, industry, target_countries.join(', ')].filter(Boolean);
  const searchLine = parts.join(' | ') || resolvedSourceType;

  console.log(`[sourceDiscovery] Starting: "${searchLine}", type=${resolvedSourceType}, org=${organizer_id}`);

  // Optimized system prompt (~80 words)
  const systemPrompt = `You find B2B data source URLs. Return SPECIFIC pages with company/member lists — not homepages. Focus: ${searchFocus}. Include PDFs with member lists. Verify URLs exist via search. Return ONLY a JSON array, no other text.`;

  // Build language hint from target countries
  let languageHint = '';
  if (target_countries.length === 1) {
    const lang = COUNTRY_LANGUAGES[target_countries[0]];
    if (lang) {
      const tld = target_countries[0] === 'Turkey' ? '.tr' : target_countries[0] === 'Germany' ? '.de' : target_countries[0] === 'France' ? '.fr' : '';
      languageHint = `Prefer ${lang}-language sources${tld ? ` (e.g. ${tld} domains)` : ''}.`;
    }
  } else if (target_countries.length > 1) {
    const langs = [...new Set(target_countries.map(c => COUNTRY_LANGUAGES[c]).filter(Boolean))];
    if (langs.length > 0) {
      languageHint = `Include sources in relevant local languages (${langs.slice(0, 3).join(', ')}).`;
    }
  }

  // Source type specific instruction
  const sourceTypeInstruction = SOURCE_TYPE_INSTRUCTION[resolvedSourceType] || '';

  // Optimized user prompt (~60-90 words depending on hints)
  const filterLines = [
    searchKeyword ? `Keywords: ${searchKeyword}` : '',
    industry ? `Industry: ${industry}` : '',
    target_countries.length ? `Countries: ${target_countries.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  const hintLines = [languageHint, sourceTypeInstruction].filter(Boolean).join('\n');

  const userPrompt = `Find 10-15 URLs with company/member lists.
${filterLines}
${hintLines ? '\n' + hintLines : ''}

Return JSON array: [{"url":"...","source_type":"association|directory|fair|pdf|registry|other","estimated_companies":50,"has_email_on_page":true,"language":"en","notes":"..."}]`;

  console.log(`[sourceDiscovery] Prompt lengths: system=${systemPrompt.length}, user=${userPrompt.length}`);

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
        max_tokens: 8000,
        system: systemPrompt,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: userPrompt }]
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    // FIX 1: Rate limit handling
    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('retry-after') || '60', 10);
      console.warn(`[sourceDiscovery] Rate limited (429). retry-after=${retryAfter}s`);
      return { sources: [], error: 'rate_limit', retry_after: retryAfter };
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[sourceDiscovery] API error ${response.status}: ${errorText}`);
      return { sources: [], error: `API error: ${response.status}` };
    }

    const data = await response.json();

    // Debug: log response structure
    const contentTypes = (data.content || []).map(b => b.type);
    console.log(`[sourceDiscovery] Response: stop="${data.stop_reason}", blocks=${contentTypes.length}, types=[${contentTypes.join(', ')}]`);

    // Check for web_search_tool_result errors
    if (data.content && Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'web_search_tool_result') {
          const errorBlocks = (block.content || []).filter(c => c.type === 'web_search_tool_result_error');
          if (errorBlocks.length > 0) {
            console.warn(`[sourceDiscovery] Web search errors: ${JSON.stringify(errorBlocks)}`);
          }
        }
      }
    }

    // Extract text — use LAST text block (contains JSON after web search)
    let textContent = '';
    const allTextBlocks = [];
    if (data.content && Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text') {
          allTextBlocks.push(block.text);
        }
      }
    }

    if (allTextBlocks.length > 1) {
      textContent = allTextBlocks[allTextBlocks.length - 1];
      console.log(`[sourceDiscovery] Using last of ${allTextBlocks.length} text blocks (${textContent.length} chars)`);
    } else if (allTextBlocks.length === 1) {
      textContent = allTextBlocks[0];
    }

    if (!textContent) {
      console.log('[sourceDiscovery] No text content in response. Blocks:', JSON.stringify(data.content?.map(b => ({ type: b.type, text: b.text?.slice(0, 200) }))));
      return { sources: [] };
    }

    console.log(`[sourceDiscovery] Text: ${textContent.length} chars, first 300: ${textContent.slice(0, 300)}`);

    // Parse JSON — try last block first, then all concatenated
    let sources = parseSourcesFromText(textContent);
    if (sources.length === 0 && allTextBlocks.length > 1) {
      console.log('[sourceDiscovery] Last block gave 0, trying all text concatenated...');
      sources = parseSourcesFromText(allTextBlocks.join('\n'));
    }

    // FIX 3: Domain dedup — max 3 per domain
    sources = deduplicateByDomain(sources);

    console.log(`[sourceDiscovery] Final: ${sources.length} sources (after dedup)`);
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
 * Domain dedup: max MAX_PER_DOMAIN results per domain
 */
function deduplicateByDomain(sources) {
  const seen = {};
  return sources.filter(s => {
    try {
      const d = new URL(s.url).hostname.replace(/^www\./, '');
      seen[d] = (seen[d] || 0) + 1;
      return seen[d] <= MAX_PER_DOMAIN;
    } catch {
      return true;
    }
  });
}

/**
 * Parse JSON array of sources from Claude's text response
 */
function parseSourcesFromText(text) {
  // Try direct parse
  try {
    const parsed = JSON.parse(text.trim());
    if (Array.isArray(parsed)) {
      console.log(`[sourceDiscovery] Parsed direct: ${parsed.length} items`);
      return validateSources(parsed);
    }
  } catch (e) {
    // fall through
  }

  // Try code fences
  const codeFenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeFenceMatch) {
    try {
      const parsed = JSON.parse(codeFenceMatch[1].trim());
      if (Array.isArray(parsed)) {
        console.log(`[sourceDiscovery] Parsed code fence: ${parsed.length} items`);
        return validateSources(parsed);
      }
    } catch (e) {
      // fall through
    }
  }

  // Try regex extraction
  const arrayMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) {
        console.log(`[sourceDiscovery] Parsed regex: ${parsed.length} items`);
        return validateSources(parsed);
      }
    } catch (e) {
      // fall through
    }
  }

  console.log(`[sourceDiscovery] Parse failed. Last 300 chars: ${text.slice(-300)}`);
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
