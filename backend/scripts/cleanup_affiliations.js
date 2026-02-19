#!/usr/bin/env node

/**
 * LIFFY — One-Time Cleanup: affiliations.company_name bad data
 *
 * Fixes two types of corrupted company_name values:
 *   1. Pipe-separated junk: "Name | No company | email@... | Country | ..."
 *      → Extracts first segment if it looks like a company, else NULL
 *   2. Email addresses stored as company: "user@gmail.com"
 *      → Sets to NULL
 *
 * Idempotent: safe to run multiple times.
 *
 * Usage:
 *   DATABASE_URL=<url> node backend/scripts/cleanup_affiliations.js
 *   DATABASE_URL=<url> node backend/scripts/cleanup_affiliations.js --dry-run
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const { Pool } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : false,
});

async function main() {
  console.log(`\n=== Affiliations Cleanup ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'} ===\n`);

  const client = await pool.connect();

  try {
    // 1. Count bad records
    const pipeCount = await client.query(
      `SELECT COUNT(*) AS count FROM affiliations WHERE company_name LIKE '%|%'`
    );
    const emailCount = await client.query(
      `SELECT COUNT(*) AS count FROM affiliations WHERE company_name LIKE '%@%' AND company_name NOT LIKE '%|%'`
    );

    console.log(`Pipe-separated company_name records: ${pipeCount.rows[0].count}`);
    console.log(`Email-as-company records: ${emailCount.rows[0].count}`);

    if (parseInt(pipeCount.rows[0].count) === 0 && parseInt(emailCount.rows[0].count) === 0) {
      console.log('\nNo bad data found. Nothing to clean.');
      return;
    }

    // 2. Show samples
    const pipeSamples = await client.query(
      `SELECT id, company_name FROM affiliations WHERE company_name LIKE '%|%' LIMIT 5`
    );
    if (pipeSamples.rows.length > 0) {
      console.log('\nPipe-separated samples:');
      for (const row of pipeSamples.rows) {
        const firstPart = row.company_name.split('|')[0].trim();
        console.log(`  [${row.id}] "${row.company_name.substring(0, 80)}..." → "${firstPart || 'NULL'}"`);
      }
    }

    const emailSamples = await client.query(
      `SELECT id, company_name FROM affiliations WHERE company_name LIKE '%@%' AND company_name NOT LIKE '%|%' LIMIT 5`
    );
    if (emailSamples.rows.length > 0) {
      console.log('\nEmail-as-company samples:');
      for (const row of emailSamples.rows) {
        console.log(`  [${row.id}] "${row.company_name}" → NULL`);
      }
    }

    if (DRY_RUN) {
      console.log('\n[DRY RUN] No changes made. Remove --dry-run to apply.');
      return;
    }

    // 3. Fix pipe-separated: extract first segment, NULL if it looks like a name or is empty
    await client.query('BEGIN');

    const pipeResult = await client.query(`
      UPDATE affiliations
      SET company_name = CASE
        WHEN NULLIF(TRIM(SPLIT_PART(company_name, '|', 1)), '') IS NULL THEN NULL
        WHEN TRIM(SPLIT_PART(company_name, '|', 1)) LIKE '%@%' THEN NULL
        ELSE NULLIF(TRIM(SPLIT_PART(company_name, '|', 1)), '')
      END
      WHERE company_name LIKE '%|%'
    `);
    console.log(`\nFixed ${pipeResult.rowCount} pipe-separated records`);

    // 4. Fix email-as-company: set to NULL
    const emailResult = await client.query(`
      UPDATE affiliations
      SET company_name = NULL
      WHERE company_name LIKE '%@%'
    `);
    console.log(`Fixed ${emailResult.rowCount} email-as-company records`);

    await client.query('COMMIT');

    // 5. Verify
    const remaining = await client.query(
      `SELECT COUNT(*) AS count FROM affiliations WHERE company_name LIKE '%|%' OR company_name LIKE '%@%'`
    );
    console.log(`\nRemaining bad records: ${remaining.rows[0].count}`);
    console.log('Cleanup complete.');

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('ERROR:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
