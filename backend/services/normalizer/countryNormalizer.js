/**
 * LIFFY Normalization Layer - Country Normalizer
 * Phase 1 - Step C: Shadow Mode Integration
 * 
 * Normalizes country names/variants to ISO 3166-1 alpha-2 codes.
 * 
 * RULES (from Constitution):
 * - Unknown → null
 * - No guessing
 * - Language variants resolved
 */

/**
 * Country name to ISO-2 code mapping
 * Includes common variations and languages
 */
const COUNTRY_MAP = {
  // English names
  'afghanistan': 'AF',
  'albania': 'AL',
  'algeria': 'DZ',
  'argentina': 'AR',
  'armenia': 'AM',
  'australia': 'AU',
  'austria': 'AT',
  'azerbaijan': 'AZ',
  'bahrain': 'BH',
  'bangladesh': 'BD',
  'belarus': 'BY',
  'belgium': 'BE',
  'brazil': 'BR',
  'bulgaria': 'BG',
  'canada': 'CA',
  'chile': 'CL',
  'china': 'CN',
  'colombia': 'CO',
  'croatia': 'HR',
  'cyprus': 'CY',
  'czech republic': 'CZ',
  'czechia': 'CZ',
  'denmark': 'DK',
  'egypt': 'EG',
  'estonia': 'EE',
  'finland': 'FI',
  'france': 'FR',
  'georgia': 'GE',
  'germany': 'DE',
  'greece': 'GR',
  'hong kong': 'HK',
  'hungary': 'HU',
  'india': 'IN',
  'indonesia': 'ID',
  'iran': 'IR',
  'iraq': 'IQ',
  'ireland': 'IE',
  'israel': 'IL',
  'italy': 'IT',
  'japan': 'JP',
  'jordan': 'JO',
  'kazakhstan': 'KZ',
  'kenya': 'KE',
  'kuwait': 'KW',
  'latvia': 'LV',
  'lebanon': 'LB',
  'lithuania': 'LT',
  'luxembourg': 'LU',
  'malaysia': 'MY',
  'malta': 'MT',
  'mexico': 'MX',
  'morocco': 'MA',
  'netherlands': 'NL',
  'new zealand': 'NZ',
  'nigeria': 'NG',
  'norway': 'NO',
  'oman': 'OM',
  'pakistan': 'PK',
  'panama': 'PA',
  'peru': 'PE',
  'philippines': 'PH',
  'poland': 'PL',
  'portugal': 'PT',
  'qatar': 'QA',
  'romania': 'RO',
  'russia': 'RU',
  'russian federation': 'RU',
  'saudi arabia': 'SA',
  'serbia': 'RS',
  'singapore': 'SG',
  'slovakia': 'SK',
  'slovenia': 'SI',
  'south africa': 'ZA',
  'south korea': 'KR',
  'korea': 'KR',
  'spain': 'ES',
  'sweden': 'SE',
  'switzerland': 'CH',
  'taiwan': 'TW',
  'thailand': 'TH',
  'turkey': 'TR',
  'turkiye': 'TR',
  'türkiye': 'TR',
  'ukraine': 'UA',
  'united arab emirates': 'AE',
  'uae': 'AE',
  'united kingdom': 'GB',
  'uk': 'GB',
  'great britain': 'GB',
  'england': 'GB',
  'scotland': 'GB',
  'wales': 'GB',
  'united states': 'US',
  'united states of america': 'US',
  'usa': 'US',
  'us': 'US',
  'america': 'US',
  'vietnam': 'VN',
  'viet nam': 'VN',
  
  // Turkish names
  'almanya': 'DE',
  'avusturya': 'AT',
  'belçika': 'BE',
  'birleşik krallık': 'GB',
  'çin': 'CN',
  'fransa': 'FR',
  'hollanda': 'NL',
  'ingiltere': 'GB',
  'ispanya': 'ES',
  'isveç': 'SE',
  'isviçre': 'CH',
  'italya': 'IT',
  'japonya': 'JP',
  'kanada': 'CA',
  'macaristan': 'HU',
  'mısır': 'EG',
  'norveç': 'NO',
  'polonya': 'PL',
  'portekiz': 'PT',
  'romanya': 'RO',
  'rusya': 'RU',
  'suudi arabistan': 'SA',
  'türkiye': 'TR',
  'yunanistan': 'GR',
  
  // German names
  'deutschland': 'DE',
  'frankreich': 'FR',
  'italien': 'IT',
  'niederlande': 'NL',
  'österreich': 'AT',
  'schweiz': 'CH',
  'spanien': 'ES',
  'vereinigte staaten': 'US',
  'vereinigtes königreich': 'GB',
  
  // French names
  'allemagne': 'DE',
  'angleterre': 'GB',
  'espagne': 'ES',
  'états-unis': 'US',
  'etats-unis': 'US',
  'italie': 'IT',
  'pays-bas': 'NL',
  'royaume-uni': 'GB',
  'suisse': 'CH',
  
  // Arabic transliterations
  'misr': 'EG',
  'lubnan': 'LB',
  'urdun': 'JO',
  'suriya': 'SY',
  'iraq': 'IQ',
  
  // Common abbreviations
  'ksa': 'SA',
  'prc': 'CN',
  'rok': 'KR',
  'rsa': 'ZA',
  'ru': 'RU',
  'de': 'DE',
  'fr': 'FR',
  'it': 'IT',
  'es': 'ES',
  'nl': 'NL',
  'be': 'BE',
  'at': 'AT',
  'ch': 'CH',
  'pl': 'PL',
  'cz': 'CZ',
  'hu': 'HU',
  'ro': 'RO',
  'bg': 'BG',
  'gr': 'GR',
  'pt': 'PT',
  'se': 'SE',
  'no': 'NO',
  'dk': 'DK',
  'fi': 'FI',
  'ie': 'IE',
  'jp': 'JP',
  'cn': 'CN',
  'hk': 'HK',
  'tw': 'TW',
  'sg': 'SG',
  'my': 'MY',
  'th': 'TH',
  'ph': 'PH',
  'id': 'ID',
  'vn': 'VN',
  'in': 'IN',
  'pk': 'PK',
  'bd': 'BD',
  'ae': 'AE',
  'sa': 'SA',
  'eg': 'EG',
  'za': 'ZA',
  'ng': 'NG',
  'ke': 'KE',
  'mx': 'MX',
  'br': 'BR',
  'ar': 'AR',
  'cl': 'CL',
  'co': 'CO',
  'pe': 'PE',
  'au': 'AU',
  'nz': 'NZ',
  'ca': 'CA',
  'tr': 'TR',
};

/**
 * Valid ISO 3166-1 alpha-2 codes (subset of most common)
 */
const VALID_ISO_CODES = new Set([
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR',
  'AS', 'AT', 'AU', 'AW', 'AX', 'AZ', 'BA', 'BB', 'BD', 'BE',
  'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ',
  'BR', 'BS', 'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD',
  'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR',
  'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM',
  'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI',
  'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
  'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS',
  'GT', 'GU', 'GW', 'GY', 'HK', 'HM', 'HN', 'HR', 'HT', 'HU',
  'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT',
  'JE', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN',
  'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC', 'LI', 'LK',
  'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME',
  'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ',
  'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA',
  'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU',
  'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM',
  'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS',
  'RU', 'RW', 'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI',
  'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV',
  'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK',
  'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ', 'UA',
  'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
  'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
]);

/**
 * Normalize a country string to ISO-2 code
 * 
 * @param {string|null} country - Country name, code, or variant
 * @returns {string|null} - ISO 3166-1 alpha-2 code or null
 */
function normalizeCountry(country) {
  if (!country || typeof country !== 'string') {
    return null;
  }
  
  // Trim and normalize
  const cleaned = country
    .trim()
    .toLowerCase()
    // Remove common noise
    .replace(/[()[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  if (!cleaned) {
    return null;
  }
  
  // Check if already a valid ISO code
  const upperClean = cleaned.toUpperCase();
  if (cleaned.length === 2 && VALID_ISO_CODES.has(upperClean)) {
    return upperClean;
  }
  
  // Look up in mapping
  if (COUNTRY_MAP[cleaned]) {
    return COUNTRY_MAP[cleaned];
  }
  
  // Try without diacritics (basic normalization)
  const normalized = cleaned
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  
  if (COUNTRY_MAP[normalized]) {
    return COUNTRY_MAP[normalized];
  }
  
  // Unknown country
  return null;
}

/**
 * Extract country from context text
 * 
 * @param {string} context - Text that may contain country references
 * @returns {string|null} - ISO 3166-1 alpha-2 code or null
 */
function extractCountryFromContext(context) {
  if (!context || typeof context !== 'string') {
    return null;
  }
  
  const lowerContext = context.toLowerCase();
  
  // Try to find country names in context
  // Sort by length descending to match longer names first
  const sortedCountries = Object.keys(COUNTRY_MAP).sort((a, b) => b.length - a.length);
  
  for (const countryName of sortedCountries) {
    // Look for word boundaries
    const regex = new RegExp(`\\b${countryName}\\b`, 'i');
    if (regex.test(lowerContext)) {
      return COUNTRY_MAP[countryName];
    }
  }
  
  // Try to find ISO codes (must be capitalized)
  const isoMatch = context.match(/\b([A-Z]{2})\b/);
  if (isoMatch && VALID_ISO_CODES.has(isoMatch[1])) {
    return isoMatch[1];
  }
  
  return null;
}

/**
 * Get country name from ISO code
 * 
 * @param {string} code - ISO 3166-1 alpha-2 code
 * @returns {string|null} - Country name or null
 */
function getCountryName(code) {
  if (!code || typeof code !== 'string') return null;
  
  const upperCode = code.toUpperCase();
  
  // Find first English name that maps to this code
  for (const [name, isoCode] of Object.entries(COUNTRY_MAP)) {
    if (isoCode === upperCode && /^[a-z\s]+$/.test(name)) {
      // Capitalize first letter of each word
      return name.replace(/\b\w/g, l => l.toUpperCase());
    }
  }
  
  return null;
}

module.exports = {
  normalizeCountry,
  extractCountryFromContext,
  getCountryName,
  VALID_ISO_CODES,
};
