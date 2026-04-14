#!/usr/bin/env node
/**
 * backfill_person_ids.js — Phase 4 person_id backfill script
 *
 * Backfills person_id in campaign_recipients and list_members
 * by matching email addresses to the canonical persons table.
 *
 * Usage:
 *   node backend/scripts/backfill_person_ids.js              # dry-run (default)
 *   node backend/scripts/backfill_person_ids.js --apply       # actually update
 *   node backend/scripts/backfill_person_ids.js --apply --batch=500
 *
 * Idempotent — only updates rows where person_id IS NULL.
 */

const db = require('../db');

const args = process.argv.slice(2);
const dryRun = !args.includes('--apply');
const batchArg = args.find(a => a.startsWith('--batch='));
const BATCH_SIZE = batchArg ? parseInt(batchArg.split('=')[1], 10) : 1000;

async function backfillCampaignRecipients() {
  console.log('\n--- campaign_recipients ---');

  const countRes = await db.query(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE person_id IS NULL) AS missing
     FROM campaign_recipients`
  );
  const { total, missing } = countRes.rows[0];
  console.log(`  Total rows: ${total}, Missing person_id: ${missing}`);

  if (parseInt(missing) === 0) {
    console.log('  Nothing to backfill.');
    return 0;
  }

  if (dryRun) {
    // Show how many would be matched
    const matchRes = await db.query(
      `SELECT COUNT(*) AS matchable
       FROM campaign_recipients cr
       JOIN persons pn ON LOWER(cr.email) = LOWER(pn.email)
                      AND cr.organizer_id = pn.organizer_id
       WHERE cr.person_id IS NULL`
    );
    console.log(`  Matchable: ${matchRes.rows[0].matchable} (dry-run, no changes made)`);
    return parseInt(matchRes.rows[0].matchable);
  }

  let updated = 0;
  while (true) {
    const res = await db.query(
      `UPDATE campaign_recipients cr
       SET person_id = pn.id
       FROM persons pn
       WHERE cr.person_id IS NULL
         AND LOWER(cr.email) = LOWER(pn.email)
         AND cr.organizer_id = pn.organizer_id
         AND cr.id IN (
           SELECT id FROM campaign_recipients
           WHERE person_id IS NULL
           LIMIT $1
         )`,
      [BATCH_SIZE]
    );

    if (res.rowCount === 0) break;
    updated += res.rowCount;
    console.log(`  Updated batch: ${res.rowCount} (total: ${updated})`);
  }

  console.log(`  Done. Total updated: ${updated}`);
  return updated;
}

async function backfillListMembers() {
  console.log('\n--- list_members ---');

  const countRes = await db.query(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE person_id IS NULL) AS missing
     FROM list_members`
  );
  const { total, missing } = countRes.rows[0];
  console.log(`  Total rows: ${total}, Missing person_id: ${missing}`);

  if (parseInt(missing) === 0) {
    console.log('  Nothing to backfill.');
    return 0;
  }

  if (dryRun) {
    const matchRes = await db.query(
      `SELECT COUNT(*) AS matchable
       FROM list_members lm
       JOIN prospects pr ON pr.id = lm.prospect_id
       JOIN persons pn ON LOWER(pn.email) = LOWER(pr.email)
                      AND pn.organizer_id = lm.organizer_id
       WHERE lm.person_id IS NULL`
    );
    console.log(`  Matchable: ${matchRes.rows[0].matchable} (dry-run, no changes made)`);
    return parseInt(matchRes.rows[0].matchable);
  }

  let updated = 0;
  while (true) {
    const res = await db.query(
      `UPDATE list_members lm
       SET person_id = (
         SELECT pn.id FROM persons pn
         JOIN prospects pr ON LOWER(pn.email) = LOWER(pr.email)
         WHERE pr.id = lm.prospect_id
           AND pn.organizer_id = lm.organizer_id
         LIMIT 1
       )
       WHERE lm.person_id IS NULL
         AND lm.id IN (
           SELECT id FROM list_members
           WHERE person_id IS NULL
           LIMIT $1
         )`,
      [BATCH_SIZE]
    );

    if (res.rowCount === 0) break;
    updated += res.rowCount;
    console.log(`  Updated batch: ${res.rowCount} (total: ${updated})`);
  }

  console.log(`  Done. Total updated: ${updated}`);
  return updated;
}

async function main() {
  console.log(`Phase 4 person_id backfill ${dryRun ? '(DRY RUN)' : '(APPLYING)'}`);
  console.log(`Batch size: ${BATCH_SIZE}`);

  try {
    const crUpdated = await backfillCampaignRecipients();
    const lmUpdated = await backfillListMembers();

    console.log('\n=== Summary ===');
    console.log(`  campaign_recipients: ${crUpdated}`);
    console.log(`  list_members: ${lmUpdated}`);
    if (dryRun) console.log('  (dry-run — run with --apply to execute)');
  } catch (err) {
    console.error('Backfill error:', err);
    process.exit(1);
  } finally {
    await db.end();
  }
}

main();
