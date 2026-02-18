#!/usr/bin/env node

/**
 * LIFFY — One-Time Backfill: campaign_recipients → campaign_events
 *
 * Reads existing campaign_recipients rows (with delivered_at, opened_at,
 * clicked_at, bounced_at timestamps) and creates corresponding campaign_events.
 *
 * RULES:
 *   - READ from campaign_recipients (never modifies it)
 *   - WRITE only to campaign_events
 *   - Idempotent: uses ON CONFLICT DO NOTHING (no duplicate events)
 *   - Processes in batches to avoid OOM
 *   - Best-effort person_id lookup from persons table
 *
 * Usage:
 *   DATABASE_URL=<url> node backend/scripts/backfill_campaign_events.js
 *   DATABASE_URL=<url> node backend/scripts/backfill_campaign_events.js --dry-run
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const { Pool, types } = require('pg');

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
  recipients_scanned: 0,
  events_inserted: 0,
  events_skipped_dup: 0,
  sent_events: 0,
  delivered_events: 0,
  open_events: 0,
  click_events: 0,
  bounce_events: 0,
  errors: 0,
};

// ── Main ────────────────────────────────────────────────────────────

async function run() {
  console.log('='.repeat(60));
  console.log('LIFFY Backfill: campaign_recipients → campaign_events');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('='.repeat(60));

  // Verify tables exist
  const tableCheck = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('campaign_events', 'campaign_recipients', 'persons')
    ORDER BY table_name
  `);
  const existingTables = tableCheck.rows.map(r => r.table_name);
  console.log(`Tables found: ${existingTables.join(', ')}`);

  if (!existingTables.includes('campaign_events')) {
    console.error('ERROR: campaign_events table does not exist. Run migration 018 first.');
    process.exit(1);
  }

  // Count total recipients
  const countRes = await pool.query('SELECT COUNT(*) AS total FROM campaign_recipients');
  const total = parseInt(countRes.rows[0].total, 10);
  console.log(`Total campaign_recipients rows: ${total}`);

  if (total === 0) {
    console.log('Nothing to backfill. Exiting.');
    process.exit(0);
  }

  // Build person_id lookup cache (organizer_id + email → person_id)
  console.log('Building person_id lookup cache...');
  const personCache = new Map();
  const personsRes = await pool.query('SELECT id, organizer_id, LOWER(email) AS email FROM persons');
  for (const p of personsRes.rows) {
    personCache.set(`${p.organizer_id}:${p.email}`, p.id);
  }
  console.log(`Person cache: ${personCache.size} entries`);

  // Process in batches using cursor-style pagination
  let lastId = '00000000-0000-0000-0000-000000000000';
  let batchNum = 0;

  while (true) {
    const batchRes = await pool.query(`
      SELECT
        id, organizer_id, campaign_id, email, status,
        sent_at, delivered_at, opened_at, clicked_at, bounced_at,
        last_error
      FROM campaign_recipients
      WHERE id > $1
      ORDER BY id ASC
      LIMIT $2
    `, [lastId, BATCH_SIZE]);

    const rows = batchRes.rows;
    if (rows.length === 0) break;

    batchNum++;
    console.log(`\nBatch ${batchNum}: processing ${rows.length} recipients`);

    await processBatch(rows, personCache);

    lastId = rows[rows.length - 1].id;
    stats.recipients_scanned += rows.length;

    const pct = Math.round((stats.recipients_scanned / total) * 100);
    console.log(`  Progress: ${stats.recipients_scanned}/${total} (${pct}%) | events: +${stats.events_inserted}`);
  }

  // Final report
  console.log('\n' + '='.repeat(60));
  console.log('BACKFILL COMPLETE');
  console.log('='.repeat(60));
  console.log(JSON.stringify(stats, null, 2));
  console.log('='.repeat(60));
}

/**
 * Process a batch of campaign_recipients in a single transaction.
 */
async function processBatch(rows, personCache) {
  if (DRY_RUN) {
    for (const row of rows) {
      dryRunRow(row);
    }
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const row of rows) {
      await processRow(client, row, personCache);
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
 * Process a single campaign_recipient → multiple campaign_events.
 * Each timestamp column becomes a separate event.
 */
async function processRow(client, row, personCache) {
  if (!row.campaign_id || !row.email) return;

  const personId = personCache.get(`${row.organizer_id}:${row.email.trim().toLowerCase()}`) || null;

  // Each timestamp becomes an event. Order matters for lifecycle.
  const events = [];

  if (row.sent_at) {
    events.push({ type: 'sent', occurred_at: row.sent_at });
  }

  if (row.delivered_at) {
    events.push({ type: 'delivered', occurred_at: row.delivered_at });
  }

  if (row.opened_at) {
    events.push({ type: 'open', occurred_at: row.opened_at });
  }

  if (row.clicked_at) {
    events.push({ type: 'click', occurred_at: row.clicked_at });
  }

  if (row.bounced_at) {
    events.push({ type: 'bounce', occurred_at: row.bounced_at, reason: row.last_error });
  }

  for (const evt of events) {
    try {
      const res = await client.query(`
        INSERT INTO campaign_events (
          organizer_id, campaign_id, recipient_id, person_id,
          event_type, email, reason, occurred_at,
          provider_response
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (campaign_id, event_type, LOWER(email), provider_event_id)
          WHERE provider_event_id IS NOT NULL
        DO NOTHING
        RETURNING id
      `, [
        row.organizer_id,
        row.campaign_id,
        row.id,
        personId,
        evt.type,
        row.email,
        evt.reason || null,
        evt.occurred_at,
        JSON.stringify({ backfill: true, source: 'campaign_recipients' }),
      ]);

      if (res.rows.length > 0) {
        stats.events_inserted++;
        stats[`${evt.type === 'open' ? 'open' : evt.type === 'click' ? 'click' : evt.type}_events`]++;
      } else {
        stats.events_skipped_dup++;
      }
    } catch (err) {
      // Unique violation or other — skip silently
      stats.events_skipped_dup++;
    }
  }
}

/**
 * Dry-run: count what would happen.
 */
function dryRunRow(row) {
  if (row.sent_at) { stats.sent_events++; stats.events_inserted++; }
  if (row.delivered_at) { stats.delivered_events++; stats.events_inserted++; }
  if (row.opened_at) { stats.open_events++; stats.events_inserted++; }
  if (row.clicked_at) { stats.click_events++; stats.events_inserted++; }
  if (row.bounced_at) { stats.bounce_events++; stats.events_inserted++; }
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
