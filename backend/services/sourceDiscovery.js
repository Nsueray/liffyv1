/**
 * Source Discovery Engine v2.0
 *
 * Uses Claude API with web_search tool to find B2B data sources.
 * v2: Source-type-aware search with query templates per source type.
 *
 * Input:  { keyword, industry, target_countries: [], source_type?, organizer_id }
 *         (backward compat: fair_name accepted as alias for keyword)
 * Output: { sources: [{ url, source_type, estimated_companies, has_email_on_page, language, notes }] }
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 60000;

// Source type → search focus mapping
const SOURCE_TYPE_PROMPTS = {
  trade_fair: {
    searchFocus: 'exhibitor lists and directories from trade fairs and exhibitions',
    searchPriority: [
      'Exhibitor list pages from trade fairs and exhibitions (e.g. /exhibitors, /katilimcilar, /exposants, /aussteller)',
      'PDF exhibitor catalogs from trade fairs',
      'Past edition exhibitor archives',
    ],
  },
  association: {
    searchFocus: 'member lists and directories from industry associations, federations, and unions',
    searchPriority: [
      'Direct member directory pages (e.g. /members, /uyeler, /annuaire, /mitglieder, /soci)',
      'PDF membership lists from industry associations',
      'Annual reports with member listings',
    ],
  },
  chamber: {
    searchFocus: 'member directories from chambers of commerce and industry',
    searchPriority: [
      'Chamber of commerce member search pages and directories',
      'Chamber member listing pages (e.g. /members, /uyeler)',
      'PDF member directories from chambers',
    ],
  },
  business_directory: {
    searchFocus: 'business directory and supplier portal listings',
    searchPriority: [
      'Europages or Kompass directory pages filtered by industry+country',
      'Industry-specific supplier directories and portals',
      'B2B marketplace company listing pages',
    ],
  },
  company_listing: {
    searchFocus: 'company catalog pages, blog listings, and WordPress directory pages',
    searchPriority: [
      'Company listing pages from WordPress sites or blog posts',
      'Industry catalog pages with company contacts',
      'Portal pages aggregating company information',
    ],
  },
  trade_portal: {
    searchFocus: 'trade portals with supplier and manufacturer databases',
    searchPriority: [
      'Alibaba, TradeFord, ExportHub supplier pages filtered by industry+country',
      'Trade portal manufacturer directories',
      'Export/import platform supplier listings',
    ],
  },
  government_trade: {
    searchFocus: 'government trade databases, ministry directories, and official exporter lists',
    searchPriority: [
      'Government trade ministry export databases',
      'Trade attaché published company lists',
      'Official exporter/importer registries (e.g. TOBB, trade.gov)',
    ],
  },
  custom_search: {
    searchFocus: 'any pages containing company lists, contact information, or business directories',
    searchPriority: [
      'Pages with visible email addresses and company names',
      'Structured lists or tables with business contact data',
      'PDF documents containing company directories',
    ],
  },
};

/**
 * Discover data sources (v2 — source-type-aware)
 *
 * @param {Object} params
 * @param {string} params.keyword - Search keyword (or params.fair_name for backward compat)
 * @param {string} params.industry - Industry/sector (optional for custom_search)
 * @param {string[]} params.target_countries - Target countries
 * @param {string} params.source_type - Source type (trade_fair, association, etc.)
 * @param {string} params.organizer_id - Organizer ID (for logging)
 * @returns {Promise<Object>} { sources: [...] }
 */
async function discoverSources({ keyword, fair_name, industry, target_countries = [], source_type, organizer_id }) {
  // Backward compat: fair_name → keyword
  const searchKeyword = (keyword || fair_name || '').trim();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[sourceDiscovery] ANTHROPIC_API_KEY not configured');
    return { sources: [], error: 'ANTHROPIC_API_KEY not configured' };
  }

  const resolvedSourceType = source_type || 'trade_fair';
  const sourceConfig = SOURCE_TYPE_PROMPTS[resolvedSourceType] || SOURCE_TYPE_PROMPTS.custom_search;

  console.log(`[sourceDiscovery] Starting discovery: keyword="${searchKeyword}", industry="${industry || ''}", source_type="${resolvedSourceType}", countries="${target_countries.join(', ')}"`);

  const systemPrompt = `You are a B2B data sourcing expert. Your job is to find SPECIFIC URLs that directly contain lists of company names, emails, or contact information — not homepages, not news pages, not about pages.

CRITICAL RULES:
- Every URL must point directly to a page that LISTS companies/members, not a homepage
- Prefer pages where email addresses are visible on the page itself
- PDF files with member lists are highly valuable — include them
- Do NOT return: homepages, news articles, blog posts, event pages, about pages
- Verify each URL exists by searching before including it
- If you find a site but cannot find the specific member list page, skip it entirely

You are specifically searching for: ${sourceConfig.searchFocus}`;

  const countryLine = target_countries.length > 0 ? `Target countries: ${target_countries.join(', ')}` : '';
  const industryLine = industry ? `Industry: ${industry}` : '';

  const userPrompt = `Find 15-20 SPECIFIC URLs containing company/member lists:

Search keywords: ${searchKeyword}
${industryLine}
${countryLine}

Search priority order:
${sourceConfig.searchPriority.map((p, i) => `${i + 1}. ${p}`).join('\n')}
${resolvedSourceType !== 'trade_fair' ? '' : `4. Europages or Kompass directory pages filtered by industry+country
5. Chamber of commerce member search pages`}

For EACH result you MUST search and verify the URL exists before including it.

Return JSON array with these fields per result:
- url: the SPECIFIC page URL (not homepage)
- source_type: 'pdf' | 'association' | 'fair' | 'directory' | 'registry' | 'other'
- estimated_companies: number
- has_email_on_page: true | false | 'unknown'
- language: page language
- notes: one sentence explaining exactly what this page contains

Return JSON array only. No markdown, no explanation, no code fences.`;

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
