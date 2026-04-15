#!/usr/bin/env node
/**
 * import_zoho_bengu.js — Import Bengü's Zoho CRM exports into Liffy.
 *
 * Reads 3 CSV files (Company, Contact, Lead) and upserts into persons + affiliations.
 * Idempotent: ON CONFLICT DO UPDATE with COALESCE (fills blanks, never overwrites).
 *
 * Usage:
 *   DATABASE_URL='...' node backend/scripts/import_zoho_bengu.js --dry-run
 *   DATABASE_URL='...' node backend/scripts/import_zoho_bengu.js --apply
 *
 * Without --apply, no DB writes are made.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db');
const { normalizeIndustry } = require('../utils/industryNormalizer');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ORGANIZER_ID = '63b52d61-ae2c-4dad-b429-48151b1b16d6';
const DRY_RUN = !process.argv.includes('--apply');
const BATCH_SIZE = 500;

const COMPANY_CSV = path.join(__dirname, 'Bengu_Company.csv');
const CONTACT_CSV = path.join(__dirname, 'Bengu_Contact.csv');
const LEAD_CSV    = path.join(__dirname, 'Bengu_Lead.csv');

// ---------------------------------------------------------------------------
// CSV Parser (built-in, handles quoted fields with commas/newlines)
// ---------------------------------------------------------------------------
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

/**
 * Parse a CSV file. Returns array of objects keyed by header.
 * @param {string} filePath
 * @param {number} skipLines — lines to skip before header (report metadata)
 */
function parseCSV(filePath, skipLines = 0) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');

  const headerIdx = skipLines;
  if (headerIdx >= lines.length) {
    console.error(`ERROR: File has fewer lines than skipLines (${skipLines}): ${filePath}`);
    return [];
  }

  const headers = parseCSVLine(lines[headerIdx]).map(h => h.trim());
  const rows = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCSVLine(line);
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = (cols[j] || '').trim();
    }
    rows.push(obj);
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Helper: get column value (tries multiple possible header names)
// ---------------------------------------------------------------------------
function getCol(row, ...names) {
  for (const name of names) {
    const val = row[name];
    if (val && val.trim()) return val.trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase A: Build company lookup map
// ---------------------------------------------------------------------------
function buildCompanyLookup(companyRows) {
  const lookup = new Map();
  for (const row of companyRows) {
    const name = getCol(row, 'Company Name');
    if (!name) continue;
    const key = name.toLowerCase();
    lookup.set(key, {
      country: getCol(row, 'Country.', 'Country'),
      industry: normalizeIndustry(getCol(row, 'Sector')),
      website: getCol(row, 'Website'),
      phone: getCol(row, 'Phone'),
    });
  }
  return lookup;
}

// ---------------------------------------------------------------------------
// Phase B/C: Upsert person + affiliation
// ---------------------------------------------------------------------------
async function upsertPerson(client, email, firstName, lastName) {
  const res = await client.query(
    `INSERT INTO persons (organizer_id, email, first_name, last_name)
     VALUES ($1, LOWER($2), $3, $4)
     ON CONFLICT (organizer_id, LOWER(email)) DO UPDATE SET
       first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), persons.first_name),
       last_name = COALESCE(NULLIF(EXCLUDED.last_name, ''), persons.last_name),
       updated_at = NOW()
     RETURNING id`,
    [ORGANIZER_ID, email, firstName || null, lastName || null]
  );
  return res.rows[0].id;
}

async function upsertAffiliation(client, personId, data) {
  // Skip if no company name
  if (!data.companyName) return false;

  await client.query(
    `INSERT INTO affiliations
       (organizer_id, person_id, company_name, position, phone, website, country_code, industry, source_type, source_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (organizer_id, person_id, LOWER(company_name)) WHERE company_name IS NOT NULL
     DO UPDATE SET
       position = COALESCE(NULLIF(EXCLUDED.position, ''), affiliations.position),
       phone = COALESCE(NULLIF(EXCLUDED.phone, ''), affiliations.phone),
       website = COALESCE(NULLIF(EXCLUDED.website, ''), affiliations.website),
       country_code = COALESCE(NULLIF(EXCLUDED.country_code, ''), affiliations.country_code),
       industry = COALESCE(NULLIF(EXCLUDED.industry, ''), affiliations.industry)`,
    [
      ORGANIZER_ID, personId, data.companyName, data.position || null,
      data.phone || null, data.website || null, data.countryCode || null,
      data.industry || null, data.sourceType || 'import', data.sourceRef || null,
    ]
  );
  return true;
}

/**
 * Convert long country name → 2-letter code (best-effort).
 * Falls back to first 2 chars uppercase.
 */
function countryToCode(country) {
  if (!country) return null;
  const c = country.trim();
  if (c.length <= 2) return c.toUpperCase();
  const MAP = {
    'pakistan': 'PK', 'india': 'IN', 'turkey': 'TR', 'türkiye': 'TR',
    'united kingdom': 'GB', 'united states': 'US', 'usa': 'US',
    'germany': 'DE', 'france': 'FR', 'italy': 'IT', 'spain': 'ES',
    'china': 'CN', 'japan': 'JP', 'brazil': 'BR', 'mexico': 'MX',
    'nigeria': 'NG', 'south africa': 'ZA', 'egypt': 'EG', 'kenya': 'KE',
    'ghana': 'GH', 'ethiopia': 'ET', 'tanzania': 'TZ', 'uganda': 'UG',
    'algeria': 'DZ', 'morocco': 'MA', 'tunisia': 'TN', 'senegal': 'SN',
    'kazakhstan': 'KZ', 'uzbekistan': 'UZ', 'iran': 'IR', 'iraq': 'IQ',
    'saudi arabia': 'SA', 'uae': 'AE', 'united arab emirates': 'AE',
    'qatar': 'QA', 'bahrain': 'BH', 'oman': 'OM', 'kuwait': 'KW',
    'lebanon': 'LB', 'jordan': 'JO', 'russia': 'RU', 'ukraine': 'UA',
    'poland': 'PL', 'netherlands': 'NL', 'belgium': 'BE', 'austria': 'AT',
    'switzerland': 'CH', 'sweden': 'SE', 'norway': 'NO', 'denmark': 'DK',
    'finland': 'FI', 'portugal': 'PT', 'greece': 'GR', 'romania': 'RO',
    'czech republic': 'CZ', 'hungary': 'HU', 'ireland': 'IE',
    'indonesia': 'ID', 'malaysia': 'MY', 'thailand': 'TH', 'vietnam': 'VN',
    'philippines': 'PH', 'singapore': 'SG', 'australia': 'AU',
    'new zealand': 'NZ', 'canada': 'CA', 'argentina': 'AR', 'chile': 'CL',
    'colombia': 'CO', 'peru': 'PE', 'venezuela': 'VE', 'bangladesh': 'BD',
    'sri lanka': 'LK', 'nepal': 'NP', 'myanmar': 'MM', 'cambodia': 'KH',
    'congo': 'CD', 'cameroon': 'CM', 'ivory coast': 'CI', "cote d'ivoire": 'CI',
    'rwanda': 'RW', 'mozambique': 'MZ', 'zambia': 'ZM', 'zimbabwe': 'ZW',
    'angola': 'AO', 'mali': 'ML', 'burkina faso': 'BF', 'guinea': 'GN',
    'benin': 'BJ', 'togo': 'TG', 'liberia': 'LR', 'sierra leone': 'SL',
    'gambia': 'GM', 'niger': 'NE', 'chad': 'TD', 'sudan': 'SD',
    'libya': 'LY', 'palestine': 'PS', 'israel': 'IL', 'cyprus': 'CY',
    'malta': 'MT', 'luxembourg': 'LU', 'iceland': 'IS', 'georgia': 'GE',
    'armenia': 'AM', 'azerbaijan': 'AZ', 'tajikistan': 'TJ',
    'turkmenistan': 'TM', 'kyrgyzstan': 'KG', 'mongolia': 'MN',
    'south korea': 'KR', 'north korea': 'KP', 'taiwan': 'TW',
    'hong kong': 'HK', 'macau': 'MO',
  };
  return MAP[c.toLowerCase()] || c.substring(0, 2).toUpperCase();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== Zoho CRM Import for Bengü ===');
  console.log(`Organizer: ${ORGANIZER_ID}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no DB writes)' : 'APPLY (writing to DB)'}`);
  console.log();

  // Check files
  for (const [label, fp] of [['Company', COMPANY_CSV], ['Contact', CONTACT_CSV], ['Lead', LEAD_CSV]]) {
    if (!fs.existsSync(fp)) {
      console.error(`ERROR: ${label} CSV not found: ${fp}`);
      console.error(`Copy Bengü's CSV files to backend/scripts/ and try again.`);
      process.exit(1);
    }
  }

  // -----------------------------------------------------------------------
  // Phase A: Company lookup
  // -----------------------------------------------------------------------
  console.log('[Phase A] Parsing Companies CSV...');
  const companyRows = parseCSV(COMPANY_CSV, 5); // 5 lines metadata, header at line 6 (0-indexed)
  const companyLookup = buildCompanyLookup(companyRows);
  console.log(`[Phase A] ${companyLookup.size} companies loaded into lookup`);

  // Show sector distribution
  const sectorDist = {};
  for (const [, v] of companyLookup) {
    const ind = v.industry || '(none)';
    sectorDist[ind] = (sectorDist[ind] || 0) + 1;
  }
  console.log('[Phase A] Industry distribution:');
  Object.entries(sectorDist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([k, v]) => console.log(`  ${k}: ${v}`));

  if (DRY_RUN) {
    // Parse and count contacts/leads for dry-run summary
    console.log('\n[Phase B] Parsing Contacts CSV...');
    const contactRows = parseCSV(CONTACT_CSV, 5);
    const contactsWithEmail = contactRows.filter(r => getCol(r, 'Email'));
    console.log(`[Phase B] ${contactRows.length} rows, ${contactsWithEmail.length} with email`);

    console.log('\n[Phase C] Parsing Leads CSV...');
    const leadRows = parseCSV(LEAD_CSV, 0);
    const leadsWithEmail = leadRows.filter(r => getCol(r, 'Email'));
    console.log(`[Phase C] ${leadRows.length} rows, ${leadsWithEmail.length} with email`);

    console.log('\n=== DRY RUN SUMMARY ===');
    console.log(`Companies lookup: ${companyLookup.size}`);
    console.log(`Contacts to import: ${contactsWithEmail.length}`);
    console.log(`Leads to import: ${leadsWithEmail.length}`);
    console.log(`Total records: ${contactsWithEmail.length + leadsWithEmail.length}`);
    console.log('\nRun with --apply to write to database.');
    process.exit(0);
  }

  // -----------------------------------------------------------------------
  // Phase B: Contacts CSV → persons + affiliations
  // -----------------------------------------------------------------------
  console.log('\n[Phase B] Importing Contacts...');
  const contactRows = parseCSV(CONTACT_CSV, 5);
  let cPersons = 0, cAffs = 0, cSkipped = 0, cErrors = 0;

  for (let i = 0; i < contactRows.length; i += BATCH_SIZE) {
    const batch = contactRows.slice(i, i + BATCH_SIZE);
    const client = await db.connect();

    try {
      await client.query('BEGIN');

      for (const row of batch) {
        const email = getCol(row, 'Email');
        if (!email || !email.includes('@')) {
          cSkipped++;
          continue;
        }

        try {
          const firstName = getCol(row, 'First Name');
          const lastName = getCol(row, 'Last Name');
          const companyName = getCol(row, 'Company Name');
          const phone = getCol(row, 'Phone', 'Mobile', 'Home Phone');
          const position = getCol(row, 'Title');
          const sectorRaw = getCol(row, 'Sector');
          const countryRaw = getCol(row, 'Country.', 'Country');

          // Enrich from company lookup
          const companyData = companyName ? companyLookup.get(companyName.toLowerCase()) : null;

          const personId = await upsertPerson(client, email, firstName, lastName);
          cPersons++;

          if (companyName) {
            const affCreated = await upsertAffiliation(client, personId, {
              companyName,
              position,
              phone,
              website: companyData?.website || null,
              countryCode: countryToCode(countryRaw || companyData?.country),
              industry: normalizeIndustry(sectorRaw) || companyData?.industry || null,
              sourceType: 'import',
              sourceRef: 'Zoho Contacts CSV',
            });
            if (affCreated) cAffs++;
          }
        } catch (rowErr) {
          cErrors++;
          if (cErrors <= 10) console.error(`  [Contact row error] ${rowErr.message}`);
        }
      }

      await client.query('COMMIT');
    } catch (batchErr) {
      await client.query('ROLLBACK');
      console.error(`  [Contact batch error at ${i}] ${batchErr.message}`);
      cErrors++;
    } finally {
      client.release();
    }

    if ((i / BATCH_SIZE) % 10 === 0 || i + BATCH_SIZE >= contactRows.length) {
      const progress = Math.min(i + BATCH_SIZE, contactRows.length);
      console.log(`  [Phase B] ${progress}/${contactRows.length} — ${cPersons} persons, ${cAffs} affiliations`);
    }
  }

  console.log(`[Phase B] Done: ${cPersons} persons, ${cAffs} affiliations, ${cSkipped} skipped, ${cErrors} errors`);

  // -----------------------------------------------------------------------
  // Phase C: Leads CSV → persons + affiliations (50K)
  // -----------------------------------------------------------------------
  console.log('\n[Phase C] Importing Leads...');
  const leadRows = parseCSV(LEAD_CSV, 0);
  let lPersons = 0, lAffs = 0, lSkipped = 0, lErrors = 0;

  for (let i = 0; i < leadRows.length; i += BATCH_SIZE) {
    const batch = leadRows.slice(i, i + BATCH_SIZE);
    const client = await db.connect();

    try {
      await client.query('BEGIN');

      for (const row of batch) {
        const email = getCol(row, 'Email');
        if (!email || !email.includes('@')) {
          lSkipped++;
          continue;
        }

        try {
          const firstName = getCol(row, 'First Name');
          const lastName = getCol(row, 'Last Name');
          const companyName = getCol(row, 'Company');
          const phone = getCol(row, 'Phone', 'Mobile');
          const position = getCol(row, 'Title');
          const sectorRaw = getCol(row, 'Sector');
          const countryRaw = getCol(row, 'Country.', 'Country');
          const leadSource = getCol(row, 'Lead Source');
          const exhibition = getCol(row, 'Interested Exhibitions');

          // Enrich from company lookup
          const companyData = companyName ? companyLookup.get(companyName.toLowerCase()) : null;

          // Build source_ref
          const srcParts = ['Zoho Leads CSV'];
          if (leadSource) srcParts.push(leadSource);
          if (exhibition) srcParts.push(exhibition);

          const personId = await upsertPerson(client, email, firstName, lastName);
          lPersons++;

          if (companyName) {
            const affCreated = await upsertAffiliation(client, personId, {
              companyName,
              position,
              phone,
              website: companyData?.website || null,
              countryCode: countryToCode(countryRaw || companyData?.country),
              industry: normalizeIndustry(sectorRaw) || companyData?.industry || null,
              sourceType: 'import',
              sourceRef: srcParts.join(' | '),
            });
            if (affCreated) lAffs++;
          }
        } catch (rowErr) {
          lErrors++;
          if (lErrors <= 10) console.error(`  [Lead row error] ${rowErr.message}`);
        }
      }

      await client.query('COMMIT');
    } catch (batchErr) {
      await client.query('ROLLBACK');
      console.error(`  [Lead batch error at ${i}] ${batchErr.message}`);
      lErrors++;
    } finally {
      client.release();
    }

    const batchNum = Math.floor(i / BATCH_SIZE);
    if (batchNum % 10 === 0 || i + BATCH_SIZE >= leadRows.length) {
      const progress = Math.min(i + BATCH_SIZE, leadRows.length);
      console.log(`  [Phase C] ${progress}/${leadRows.length} — ${lPersons} persons, ${lAffs} affiliations`);
    }
  }

  console.log(`[Phase C] Done: ${lPersons} persons, ${lAffs} affiliations, ${lSkipped} skipped, ${lErrors} errors`);

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  const totalPersons = await db.query(
    `SELECT COUNT(*) FROM persons WHERE organizer_id = $1`, [ORGANIZER_ID]
  );
  const totalAffs = await db.query(
    `SELECT COUNT(*) FROM affiliations WHERE organizer_id = $1`, [ORGANIZER_ID]
  );

  console.log('\n=== IMPORT SUMMARY ===');
  console.log(`Companies lookup: ${companyLookup.size} loaded`);
  console.log(`Contacts: ${contactRows.length} processed — ${cPersons} persons, ${cAffs} affiliations, ${cSkipped} skipped`);
  console.log(`Leads: ${leadRows.length} processed — ${lPersons} persons, ${lAffs} affiliations, ${lSkipped} skipped`);
  console.log(`Errors: ${cErrors + lErrors}`);
  console.log(`Total persons in DB: ${totalPersons.rows[0].count}`);
  console.log(`Total affiliations in DB: ${totalAffs.rows[0].count}`);

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
