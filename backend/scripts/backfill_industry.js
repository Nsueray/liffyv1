#!/usr/bin/env node
/**
 * backfill_industry.js — Backfill industry column on affiliations from Bengu CRM CSV.
 *
 * Reads Bengu_Company.csv, matches company_name → affiliations row, sets industry.
 *
 * Usage:
 *   node backend/scripts/backfill_industry.js
 *   node backend/scripts/backfill_industry.js --dry-run
 *   node backend/scripts/backfill_industry.js --csv path/to/companies.csv
 *
 * Requires: DATABASE_URL or Render env vars, migration 020 applied.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db');
const { normalizeIndustry } = require('../utils/industryNormalizer');

const DRY_RUN = process.argv.includes('--dry-run');
const CSV_FLAG_IDX = process.argv.indexOf('--csv');
const CSV_PATH = CSV_FLAG_IDX !== -1 && process.argv[CSV_FLAG_IDX + 1]
  ? process.argv[CSV_FLAG_IDX + 1]
  : path.join(__dirname, 'Bengu_Company.csv');

// --- CSV parser (handles Bengu header format) ---
function parseBenguCSV(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');

  // Find header row (contains "Company Name" and "Sector")
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (lines[i].includes('Company Name') && lines[i].includes('Sector')) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    console.error('ERROR: Could not find header row with "Company Name" and "Sector"');
    process.exit(1);
  }

  const headers = parseCSVLine(lines[headerIdx]);
  const companyIdx = headers.findIndex(h => h.trim() === 'Company Name');
  const sectorIdx = headers.findIndex(h => h.trim() === 'Sector');
  const countryIdx = headers.findIndex(h => h.trim().startsWith('Country'));

  if (companyIdx === -1 || sectorIdx === -1) {
    console.error('ERROR: Missing required columns. Found:', headers);
    process.exit(1);
  }

  console.log(`[CSV] Header at line ${headerIdx + 1}: companyIdx=${companyIdx}, sectorIdx=${sectorIdx}, countryIdx=${countryIdx}`);

  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCSVLine(line);
    const companyName = (cols[companyIdx] || '').trim();
    const sector = (cols[sectorIdx] || '').trim();
    if (companyName && sector) {
      rows.push({
        company_name: companyName,
        sector_raw: sector,
        industry: normalizeIndustry(sector),
        country: countryIdx !== -1 ? (cols[countryIdx] || '').trim() : null,
      });
    }
  }

  return rows;
}

// Simple CSV line parser (handles quoted fields with commas)
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

// --- Main ---
async function main() {
  console.log(`[Backfill] CSV: ${CSV_PATH}`);
  console.log(`[Backfill] Dry run: ${DRY_RUN}`);

  if (!fs.existsSync(CSV_PATH)) {
    console.error(`ERROR: CSV file not found: ${CSV_PATH}`);
    process.exit(1);
  }

  const companies = parseBenguCSV(CSV_PATH);
  console.log(`[Backfill] Parsed ${companies.length} companies with sector data`);

  // Show sector distribution
  const sectorCounts = {};
  for (const c of companies) {
    sectorCounts[c.industry || 'NULL'] = (sectorCounts[c.industry || 'NULL'] || 0) + 1;
  }
  console.log('[Backfill] Industry distribution:');
  for (const [ind, count] of Object.entries(sectorCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ind}: ${count}`);
  }

  if (DRY_RUN) {
    console.log('[Backfill] Dry run — no DB changes made.');
    process.exit(0);
  }

  // Process in batches
  const BATCH_SIZE = 50;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < companies.length; i += BATCH_SIZE) {
    const batch = companies.slice(i, i + BATCH_SIZE);

    for (const c of batch) {
      try {
        // Match by company_name (case-insensitive) across all organizers
        const result = await db.query(
          `UPDATE affiliations
           SET industry = $1
           WHERE LOWER(company_name) = LOWER($2)
             AND (industry IS NULL OR industry = '')`,
          [c.industry, c.company_name]
        );

        if (result.rowCount > 0) {
          updated += result.rowCount;
        } else {
          skipped++;
        }
      } catch (err) {
        console.error(`  [FAIL] ${c.company_name}: ${err.message}`);
        failed++;
      }
    }

    const progress = Math.min(i + BATCH_SIZE, companies.length);
    console.log(`[Backfill] Progress: ${progress}/${companies.length} processed (${updated} rows updated)`);
  }

  console.log('\n=== BACKFILL SUMMARY ===');
  console.log(`Companies processed: ${companies.length}`);
  console.log(`Affiliation rows updated: ${updated}`);
  console.log(`Companies not found in DB: ${skipped}`);
  console.log(`Failed: ${failed}`);

  // Show remaining NULL industry count
  const nullRes = await db.query(
    `SELECT COUNT(*) FROM affiliations WHERE industry IS NULL AND company_name IS NOT NULL AND company_name NOT LIKE '%@%'`
  );
  console.log(`Affiliations still without industry: ${nullRes.rows[0].count}`);

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
