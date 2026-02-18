#!/usr/bin/env node

/**
 * LIFFY — One-Time Backfill: mining_results → persons + affiliations
 *
 * Reads existing mining_results rows and populates the new canonical
 * persons and affiliations tables.
 *
 * RULES:
 *   - READ from mining_results (never modifies it)
 *   - WRITE only to persons and affiliations
 *   - Uses the same normalizer logic (nameParser, countryNormalizer)
 *   - Idempotent: safe to run multiple times (UPSERT / ON CONFLICT)
 *   - Processes in batches to avoid OOM on large datasets
 *   - Logs progress and final stats
 *
 * Usage:
 *   DATABASE_URL=<url> node backend/scripts/backfill_persons.js
 *   DATABASE_URL=<url> node backend/scripts/backfill_persons.js --dry-run
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const { Pool, types } = require('pg');
const { parseName } = require('../services/normalizer/nameParser');
const { normalizeCountry } = require('../services/normalizer/countryNormalizer');

// ── Config ──────────────────────────────────────────────────────────
const BATCH_SIZE = 500;
const DRY_RUN = process.argv.includes('--dry-run');

// ── DB Pool ─────────────────────────────────────────────────────────
types.setTypeParser(17, (val) => {
  if (Buffer.isBuffer(val)) return val;
  if (typeof val === 'string' && val.startsWith('\\x')) return Buffer.from(val.slice(2), 'hex');
  return val;
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 5,
});

// ── Stats ───────────────────────────────────────────────────────────
const stats = {
  results_scanned: 0,
  results_with_email: 0,
  results_skipped_no_email: 0,
  results_skipped_no_organizer: 0,
  persons_inserted: 0,
  persons_updated: 0,
  affiliations_inserted: 0,
  affiliations_skipped_dup: 0,
  errors: 0,
};

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Extract primary email from mining_results.emails (text[]).
 * Returns trimmed lowercase string or null.
 */
function extractPrimaryEmail(emails) {
  if (!emails || !Array.isArray(emails)) return null;
  const found = emails.find(e => e && typeof e === 'string' && e.includes('@'));
  return found ? found.trim().toLowerCase() : null;
}

/**
 * Parse contact_name into first_name / last_name.
 * Falls back to email-based extraction via nameParser.
 */
function parseContactName(contactName, email) {
  // Try splitting contact_name directly first
  if (contactName && typeof contactName === 'string') {
    const cleaned = contactName.trim();
    if (cleaned.length > 0) {
      const parts = cleaned.split(/\s+/);
      if (parts.length >= 2) {
        return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
      }
      if (parts.length === 1 && parts[0].length >= 2) {
        return { first_name: parts[0], last_name: null };
      }
    }
  }

  // Fall back to normalizer's name parser (email prefix based)
  return parseName(email, contactName);
}

// ── Main ────────────────────────────────────────────────────────────

async function run() {
  console.log('='.repeat(60));
  console.log('LIFFY Backfill: mining_results → persons + affiliations');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('='.repeat(60));

  // Verify tables exist
  const tableCheck = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('persons', 'affiliations', 'mining_results')
    ORDER BY table_name
  `);
  const existingTables = tableCheck.rows.map(r => r.table_name);
  console.log(`Tables found: ${existingTables.join(', ')}`);

  if (!existingTables.includes('persons') || !existingTables.includes('affiliations')) {
    console.error('ERROR: persons and/or affiliations tables do not exist. Run migrations first.');
    process.exit(1);
  }

  // Count total results
  const countRes = await pool.query('SELECT COUNT(*) AS total FROM mining_results');
  const total = parseInt(countRes.rows[0].total, 10);
  console.log(`Total mining_results rows: ${total}`);

  if (total === 0) {
    console.log('Nothing to backfill. Exiting.');
    process.exit(0);
  }

  // Process in batches using cursor-style pagination (id-based)
  let lastId = '00000000-0000-0000-0000-000000000000';
  let batchNum = 0;

  while (true) {
    const batchRes = await pool.query(`
      SELECT
        id, job_id, organizer_id,
        company_name, contact_name, job_title,
        emails, website, phone, country, city, address,
        source_url, confidence_score, raw
      FROM mining_results
      WHERE id > $1
      ORDER BY id ASC
      LIMIT $2
    `, [lastId, BATCH_SIZE]);

    const rows = batchRes.rows;
    if (rows.length === 0) break;

    batchNum++;
    console.log(`\nBatch ${batchNum}: processing ${rows.length} rows (after id ${lastId.slice(0, 8)}...)`);

    await processBatch(rows);

    lastId = rows[rows.length - 1].id;
    stats.results_scanned += rows.length;

    // Progress
    const pct = Math.round((stats.results_scanned / total) * 100);
    console.log(`  Progress: ${stats.results_scanned}/${total} (${pct}%) | persons: +${stats.persons_inserted}/~${stats.persons_updated} | affiliations: +${stats.affiliations_inserted}`);
  }

  // Final report
  console.log('\n' + '='.repeat(60));
  console.log('BACKFILL COMPLETE');
  console.log('='.repeat(60));
  console.log(JSON.stringify(stats, null, 2));
  console.log('='.repeat(60));
}

/**
 * Process a batch of mining_results rows in a single transaction.
 */
async function processBatch(rows) {
  if (DRY_RUN) {
    // In dry-run: count what would happen without writing
    for (const row of rows) {
      dryRunRow(row);
    }
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const row of rows) {
      await processRow(client, row);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`  ERROR in batch: ${err.message}`);
    stats.errors++;
  } finally {
    client.release();
  }
}

/**
 * Process a single mining_results row → person + affiliation.
 */
async function processRow(client, row) {
  // Must have organizer_id
  if (!row.organizer_id) {
    stats.results_skipped_no_organizer++;
    return;
  }

  // Extract primary email
  const email = extractPrimaryEmail(row.emails);
  if (!email) {
    stats.results_skipped_no_email++;
    return;
  }

  stats.results_with_email++;

  // Parse name
  const { first_name, last_name } = parseContactName(row.contact_name, email);

  // 1. UPSERT person
  const personRes = await client.query(`
    INSERT INTO persons (organizer_id, email, first_name, last_name)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (organizer_id, LOWER(email))
    DO UPDATE SET
      first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), persons.first_name),
      last_name  = COALESCE(NULLIF(EXCLUDED.last_name, ''), persons.last_name),
      updated_at = NOW()
    RETURNING id, (xmax = 0) AS inserted
  `, [
    row.organizer_id,
    email,
    first_name || null,
    last_name || null,
  ]);

  const personId = personRes.rows[0].id;
  if (personRes.rows[0].inserted) {
    stats.persons_inserted++;
  } else {
    stats.persons_updated++;
  }

  // 2. INSERT affiliation (if any contextual data exists)
  const companyName = row.company_name && row.company_name.trim() ? row.company_name.trim() : null;
  const countryCode = normalizeCountry(row.country);
  const position = row.job_title && row.job_title.trim() ? row.job_title.trim() : null;
  const confidence = typeof row.confidence_score === 'number'
    ? Math.min(row.confidence_score / 100, 1)   // mining_results stores 0-100, affiliations stores 0-1
    : null;

  // Build raw audit payload
  const raw = {
    backfill: true,
    mining_result_id: row.id,
    original: {
      contact_name: row.contact_name,
      emails: row.emails,
      country: row.country,
      city: row.city,
      address: row.address,
    },
  };

  if (companyName) {
    // UPSERT: person + company dedup
    const affRes = await client.query(`
      INSERT INTO affiliations (
        organizer_id, person_id, company_name, position,
        country_code, city, website, phone,
        source_type, source_ref, mining_job_id, confidence, raw
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (organizer_id, person_id, LOWER(company_name))
        WHERE company_name IS NOT NULL
      DO UPDATE SET
        position     = COALESCE(NULLIF(EXCLUDED.position, ''), affiliations.position),
        country_code = COALESCE(NULLIF(EXCLUDED.country_code, ''), affiliations.country_code),
        city         = COALESCE(NULLIF(EXCLUDED.city, ''), affiliations.city),
        website      = COALESCE(NULLIF(EXCLUDED.website, ''), affiliations.website),
        phone        = COALESCE(NULLIF(EXCLUDED.phone, ''), affiliations.phone),
        confidence   = GREATEST(EXCLUDED.confidence, affiliations.confidence),
        raw          = EXCLUDED.raw
      RETURNING (xmax = 0) AS inserted
    `, [
      row.organizer_id, personId, companyName,
      position,
      countryCode,
      row.city || null,
      row.website || null,
      row.phone || null,
      'mining',
      row.source_url || null,
      row.job_id || null,
      confidence,
      JSON.stringify(raw),
    ]);

    if (affRes.rows[0].inserted) {
      stats.affiliations_inserted++;
    } else {
      stats.affiliations_skipped_dup++;
    }
  } else {
    // No company — insert with NULL company (no conflict path)
    await client.query(`
      INSERT INTO affiliations (
        organizer_id, person_id, company_name, position,
        country_code, city, website, phone,
        source_type, source_ref, mining_job_id, confidence, raw
      ) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [
      row.organizer_id, personId,
      position,
      countryCode,
      row.city || null,
      row.website || null,
      row.phone || null,
      'mining',
      row.source_url || null,
      row.job_id || null,
      confidence,
      JSON.stringify(raw),
    ]);

    stats.affiliations_inserted++;
  }
}

/**
 * Dry-run: count what would happen without writing.
 */
function dryRunRow(row) {
  if (!row.organizer_id) {
    stats.results_skipped_no_organizer++;
    return;
  }

  const email = extractPrimaryEmail(row.emails);
  if (!email) {
    stats.results_skipped_no_email++;
    return;
  }

  stats.results_with_email++;
  stats.persons_inserted++;   // approximate
  stats.affiliations_inserted++;
}

// ── Entry ───────────────────────────────────────────────────────────

run()
  .then(() => {
    console.log('\nDone.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nFATAL ERROR:', err);
    process.exit(1);
  });
