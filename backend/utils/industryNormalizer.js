/**
 * industryNormalizer.js — Maps raw sector strings to normalized industry values.
 *
 * Canonical industries (matching Bengu CRM sectors):
 *   Food, Food Machinery, Construction, Ceramics, Decoration / Furniture,
 *   Electricity, HVAC, Textile, Packaging, Plastics, Chemicals,
 *   Agriculture, Mining, Automotive, Healthcare, Technology, Logistics,
 *   Energy, Other
 */

// Canonical industry list
const CANONICAL_INDUSTRIES = [
  'Food',
  'Food Machinery',
  'Construction',
  'Ceramics',
  'Decoration / Furniture',
  'Electricity',
  'HVAC',
  'Textile',
  'Packaging',
  'Plastics',
  'Chemicals',
  'Agriculture',
  'Mining',
  'Automotive',
  'Healthcare',
  'Technology',
  'Logistics',
  'Energy',
  'Other',
];

// Map of lowercase aliases → canonical industry
const ALIAS_MAP = {
  'food': 'Food',
  'food machinery': 'Food Machinery',
  'food processing': 'Food Machinery',
  'food & beverage': 'Food',
  'food and beverage': 'Food',
  'f&b': 'Food',
  'construction': 'Construction',
  'building': 'Construction',
  'building materials': 'Construction',
  'ceramics': 'Ceramics',
  'ceramic': 'Ceramics',
  'tiles': 'Ceramics',
  'decoration / furniture': 'Decoration / Furniture',
  'decoration/furniture': 'Decoration / Furniture',
  'decoration': 'Decoration / Furniture',
  'furniture': 'Decoration / Furniture',
  'interior': 'Decoration / Furniture',
  'interior design': 'Decoration / Furniture',
  'electricity': 'Electricity',
  'electrical': 'Electricity',
  'electronics': 'Electricity',
  'hvac': 'HVAC',
  'heating': 'HVAC',
  'ventilation': 'HVAC',
  'air conditioning': 'HVAC',
  'textile': 'Textile',
  'textiles': 'Textile',
  'garment': 'Textile',
  'apparel': 'Textile',
  'packaging': 'Packaging',
  'pack': 'Packaging',
  'plastics': 'Plastics',
  'plastic': 'Plastics',
  'rubber': 'Plastics',
  'chemicals': 'Chemicals',
  'chemical': 'Chemicals',
  'agriculture': 'Agriculture',
  'agri': 'Agriculture',
  'agritech': 'Agriculture',
  'farming': 'Agriculture',
  'mining': 'Mining',
  'metals': 'Mining',
  'steel': 'Mining',
  'automotive': 'Automotive',
  'auto': 'Automotive',
  'vehicle': 'Automotive',
  'healthcare': 'Healthcare',
  'health': 'Healthcare',
  'medical': 'Healthcare',
  'pharma': 'Healthcare',
  'pharmaceutical': 'Healthcare',
  'technology': 'Technology',
  'tech': 'Technology',
  'it': 'Technology',
  'software': 'Technology',
  'logistics': 'Logistics',
  'transport': 'Logistics',
  'shipping': 'Logistics',
  'energy': 'Energy',
  'oil': 'Energy',
  'gas': 'Energy',
  'solar': 'Energy',
  'renewable': 'Energy',
  'other': 'Other',
  'unknown': 'Other',
};

/**
 * Normalize a raw sector/industry string to a canonical value.
 * Returns null if input is empty/null.
 */
function normalizeIndustry(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();

  // Direct alias match
  if (ALIAS_MAP[lower]) return ALIAS_MAP[lower];

  // Exact canonical match (case-insensitive)
  const canonical = CANONICAL_INDUSTRIES.find(c => c.toLowerCase() === lower);
  if (canonical) return canonical;

  // Substring match — check if any alias is contained
  for (const [alias, industry] of Object.entries(ALIAS_MAP)) {
    if (alias.length >= 4 && lower.includes(alias)) return industry;
  }

  // If raw is non-empty but unrecognized, return as-is (preserves new sectors)
  return trimmed;
}

module.exports = { normalizeIndustry, CANONICAL_INDUSTRIES };
