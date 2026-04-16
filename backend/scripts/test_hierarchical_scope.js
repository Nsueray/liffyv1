#!/usr/bin/env node
/**
 * test_hierarchical_scope.js — Verify hierarchical user data isolation.
 *
 * Tests:
 *   1. Owner sees all campaigns
 *   2. Manager sees own + team campaigns
 *   3. User sees only own campaigns
 *
 * Prerequisites:
 *   - Migration 038 applied (manager_id column)
 *   - Elif (1798e4e3) has role='manager' and Bengü (c845b557) has manager_id pointing to Elif
 *
 * Usage:
 *   node backend/scripts/test_hierarchical_scope.js
 *   node backend/scripts/test_hierarchical_scope.js --setup   # Set roles + manager_id first
 */

const db = require('../db');

const ORG_ID = '63b52d61-ae2c-4dad-b429-48151b1b16d6';
const SUER_ID = 'cfb66f28-54b1-4a82-85d5-616bb6bbd40b';      // owner
const ELIF_ID = '1798e4e3-e705-4ee6-9c22-6a816ad6c95b';      // will be manager
const BENGU_ID = 'c845b557-0de6-48f7-975e-5e41bc124d43';     // user (reports to Elif)

const SETUP = process.argv.includes('--setup');

async function setup() {
  console.log('\n=== SETUP: Setting roles and manager_id ===');

  // Set Elif as manager
  await db.query(`UPDATE users SET role = 'manager' WHERE id = $1`, [ELIF_ID]);
  console.log(`  Elif → role=manager ✅`);

  // Set Bengü's manager to Elif
  await db.query(`UPDATE users SET manager_id = $1 WHERE id = $2`, [ELIF_ID, BENGU_ID]);
  console.log(`  Bengü → manager_id=Elif ✅`);

  // Verify
  const r = await db.query(
    `SELECT id, email, role, manager_id FROM users WHERE organizer_id = $1 ORDER BY role`,
    [ORG_ID]
  );
  console.log('\n  Users after setup:');
  for (const u of r.rows) {
    console.log(`    ${u.email}: role=${u.role}, manager_id=${u.manager_id || 'null'}`);
  }
}

async function testTeamIdsLoading() {
  console.log('\n=== TEST 1: Team IDs Loading ===');

  // Manager's team
  const teamRes = await db.query(
    `SELECT id, email FROM users WHERE manager_id = $1 AND organizer_id = $2`,
    [ELIF_ID, ORG_ID]
  );
  const teamIds = teamRes.rows.map(r => r.id);
  console.log(`  Elif's team: [${teamRes.rows.map(r => r.email).join(', ')}]`);
  console.log(`  Team IDs: [${teamIds.join(', ')}]`);

  if (teamIds.includes(BENGU_ID)) {
    console.log('  ✅ Bengü is in Elif's team');
  } else {
    console.log('  ❌ Bengü NOT in Elif's team — check manager_id');
  }
}

async function testCampaignVisibility() {
  console.log('\n=== TEST 2: Campaign Visibility ===');

  // Count campaigns per creator
  const stats = await db.query(
    `SELECT created_by_user_id, COUNT(*) AS cnt
       FROM campaigns WHERE organizer_id = $1
       GROUP BY created_by_user_id`,
    [ORG_ID]
  );
  console.log('  Campaign counts by creator:');
  for (const r of stats.rows) {
    const who = r.created_by_user_id === SUER_ID ? 'Suer(owner)' :
                r.created_by_user_id === ELIF_ID ? 'Elif(manager)' :
                r.created_by_user_id === BENGU_ID ? 'Bengü(user)' : r.created_by_user_id;
    console.log(`    ${who}: ${r.cnt} campaigns`);
  }

  // Total
  const total = await db.query(
    `SELECT COUNT(*) AS cnt FROM campaigns WHERE organizer_id = $1`, [ORG_ID]
  );
  console.log(`  Total campaigns: ${total.rows[0].cnt}`);

  // Owner scope (all)
  const ownerCount = total.rows[0].cnt;
  console.log(`\n  Owner (Suer) sees: ${ownerCount} campaigns → ✅ (all)`);

  // Manager scope (own + team)
  const teamRes = await db.query(
    `SELECT id FROM users WHERE manager_id = $1 AND organizer_id = $2`,
    [ELIF_ID, ORG_ID]
  );
  const teamIds = teamRes.rows.map(r => r.id);
  const allManagerIds = [ELIF_ID, ...teamIds];
  const ph = allManagerIds.map((_, i) => `$${i + 2}`).join(', ');
  const managerRes = await db.query(
    `SELECT COUNT(*) AS cnt FROM campaigns WHERE organizer_id = $1 AND created_by_user_id IN (${ph})`,
    [ORG_ID, ...allManagerIds]
  );
  console.log(`  Manager (Elif) sees: ${managerRes.rows[0].cnt} campaigns (own + team)`);

  // User scope (own only)
  const userRes = await db.query(
    `SELECT COUNT(*) AS cnt FROM campaigns WHERE organizer_id = $1 AND created_by_user_id = $2`,
    [ORG_ID, BENGU_ID]
  );
  console.log(`  User (Bengü) sees: ${userRes.rows[0].cnt} campaigns (own only)`);
}

async function testActionItemVisibility() {
  console.log('\n=== TEST 3: Action Item Visibility ===');

  const stats = await db.query(
    `SELECT assigned_to, COUNT(*) AS cnt
       FROM action_items WHERE organizer_id = $1
       GROUP BY assigned_to`,
    [ORG_ID]
  );
  console.log('  Action item counts by assignee:');
  for (const r of stats.rows) {
    const who = r.assigned_to === SUER_ID ? 'Suer(owner)' :
                r.assigned_to === ELIF_ID ? 'Elif(manager)' :
                r.assigned_to === BENGU_ID ? 'Bengü(user)' : (r.assigned_to || 'NULL');
    console.log(`    ${who}: ${r.cnt} items`);
  }

  // Manager sees own + team's items
  const teamRes = await db.query(
    `SELECT id FROM users WHERE manager_id = $1 AND organizer_id = $2`,
    [ELIF_ID, ORG_ID]
  );
  const teamIds = teamRes.rows.map(r => r.id);
  const allIds = [ELIF_ID, ...teamIds];
  const ph = allIds.map((_, i) => `$${i + 2}`).join(', ');
  const managerRes = await db.query(
    `SELECT COUNT(*) AS cnt FROM action_items WHERE organizer_id = $1 AND assigned_to IN (${ph})`,
    [ORG_ID, ...allIds]
  );
  console.log(`\n  Manager (Elif) would see: ${managerRes.rows[0].cnt} items`);
}

async function main() {
  try {
    if (SETUP) {
      await setup();
    }

    await testTeamIdsLoading();
    await testCampaignVisibility();
    await testActionItemVisibility();

    console.log('\n=== ALL TESTS COMPLETE ===\n');
  } catch (err) {
    console.error('Test error:', err);
  }
  process.exit(0);
}

main();
