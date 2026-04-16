#!/usr/bin/env node
/**
 * test_adr015.js — ADR-015 Hierarchical Data Visibility test.
 *
 * Creates JWTs for each user and calls API endpoints to verify isolation.
 *
 * Prerequisites:
 *   - Migration 039 applied (reports_to, permissions, role constraint)
 *   - Server running on localhost:3001 (or API_BASE env)
 *   - Users: Suer (owner), Elif (manager, reports_to=Suer), Bengü (sales_rep, reports_to=Elif)
 *
 * Usage:
 *   node backend/scripts/test_adr015.js               # Run tests
 *   node backend/scripts/test_adr015.js --setup        # Set roles + reports_to first
 *   node backend/scripts/test_adr015.js --db-only      # DB audit only (no API calls)
 */

const jwt = require('jsonwebtoken');
const db = require('../db');

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const JWT_SECRET = process.env.JWT_SECRET || 'liffy_secret_key_change_me';

const ORG_ID = '63b52d61-ae2c-4dad-b429-48151b1b16d6';
const SUER  = { id: 'cfb66f28-54b1-4a82-85d5-616bb6bbd40b', role: 'owner',     email: 'suer@elanexpo.com' };
const ELIF  = { id: '1798e4e3-e705-4ee6-9c22-6a816ad6c95b', role: 'manager',   email: 'elif@elanexpo.com' };
const BENGU = { id: 'c845b557-0de6-48f7-975e-5e41bc124d43', role: 'sales_rep', email: 'bengu@elanexpo.com' };

const SETUP = process.argv.includes('--setup');
const DB_ONLY = process.argv.includes('--db-only');

function makeToken(user) {
  return jwt.sign({
    user_id: user.id,
    organizer_id: ORG_ID,
    role: user.role,
    email: user.email,
  }, JWT_SECRET, { expiresIn: '1h' });
}

async function apiFetch(path, token) {
  const url = `${API_BASE}${path}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { status: res.status, error: await res.text() };
    return { status: res.status, data: await res.json() };
  } catch (err) {
    return { status: 0, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────
async function setup() {
  console.log('\n=== SETUP: ADR-015 roles + reports_to hierarchy ===\n');

  // Suer → owner, reports_to NULL
  await db.query(`UPDATE users SET role = 'owner', reports_to = NULL WHERE id = $1`, [SUER.id]);
  console.log(`  Suer → owner, reports_to=NULL`);

  // Elif → manager, reports_to Suer
  await db.query(`UPDATE users SET role = 'manager', reports_to = $1 WHERE id = $2`, [SUER.id, ELIF.id]);
  console.log(`  Elif → manager, reports_to=Suer`);

  // Bengü → sales_rep, reports_to Elif
  await db.query(`UPDATE users SET role = 'sales_rep', reports_to = $1 WHERE id = $2`, [ELIF.id, BENGU.id]);
  console.log(`  Bengü → sales_rep, reports_to=Elif`);

  // Verify hierarchy
  const tree = await db.query(
    `WITH RECURSIVE tree AS (
       SELECT id, email, role, reports_to, 0 as depth FROM users WHERE organizer_id = $1 AND reports_to IS NULL
       UNION ALL
       SELECT u.id, u.email, u.role, u.reports_to, t.depth + 1
         FROM users u JOIN tree t ON u.reports_to = t.id
     )
     SELECT * FROM tree ORDER BY depth, email`,
    [ORG_ID]
  );

  console.log('\n  Hierarchy tree:');
  for (const u of tree.rows) {
    const indent = '  '.repeat(u.depth + 1);
    console.log(`  ${indent}${u.email} (${u.role}) → reports_to: ${u.reports_to || 'NULL'}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DB Audit
// ─────────────────────────────────────────────────────────────────────────────
async function dbAudit() {
  console.log('\n=== DB AUDIT ===\n');

  // Recursive CTE test
  console.log('  Recursive CTE: "Who can Elif see?"');
  const elifTeam = await db.query(
    `WITH RECURSIVE my_team AS (
       SELECT id FROM users WHERE id = $1
       UNION ALL
       SELECT u.id FROM users u JOIN my_team t ON u.reports_to = t.id
     )
     SELECT u.id, u.email, u.role FROM users u WHERE u.id IN (SELECT id FROM my_team)`,
    [ELIF.id]
  );
  for (const u of elifTeam.rows) console.log(`    ${u.email} (${u.role})`);

  console.log('\n  Recursive CTE: "Who can Bengü see?"');
  const benguTeam = await db.query(
    `WITH RECURSIVE my_team AS (
       SELECT id FROM users WHERE id = $1
       UNION ALL
       SELECT u.id FROM users u JOIN my_team t ON u.reports_to = t.id
     )
     SELECT u.id, u.email, u.role FROM users u WHERE u.id IN (SELECT id FROM my_team)`,
    [BENGU.id]
  );
  for (const u of benguTeam.rows) console.log(`    ${u.email} (${u.role})`);

  // Campaigns by creator
  console.log('\n  Campaigns by creator:');
  const camps = await db.query(
    `SELECT created_by_user_id, COUNT(*) AS cnt FROM campaigns WHERE organizer_id = $1 GROUP BY created_by_user_id`,
    [ORG_ID]
  );
  for (const r of camps.rows) {
    const who = r.created_by_user_id === SUER.id ? 'Suer' : r.created_by_user_id === ELIF.id ? 'Elif' : r.created_by_user_id === BENGU.id ? 'Bengü' : r.created_by_user_id;
    console.log(`    ${who}: ${r.cnt}`);
  }

  // Lists
  console.log('\n  Lists by creator + visibility:');
  const lists = await db.query(
    `SELECT created_by_user_id, visibility, COUNT(*) AS cnt FROM lists WHERE organizer_id = $1 GROUP BY created_by_user_id, visibility`,
    [ORG_ID]
  );
  for (const r of lists.rows) {
    const who = r.created_by_user_id === SUER.id ? 'Suer' : r.created_by_user_id === ELIF.id ? 'Elif' : r.created_by_user_id === BENGU.id ? 'Bengü' : r.created_by_user_id;
    console.log(`    ${who}: ${r.cnt} (${r.visibility})`);
  }

  // Prospects
  console.log('\n  Prospect intents by creator:');
  const intents = await db.query(
    `SELECT pi.created_by_user_id, COUNT(*) AS cnt
       FROM prospect_intents pi
      WHERE pi.organizer_id = $1
      GROUP BY pi.created_by_user_id`,
    [ORG_ID]
  );
  for (const r of intents.rows) {
    const who = r.created_by_user_id === SUER.id ? 'Suer' : r.created_by_user_id === ELIF.id ? 'Elif' : r.created_by_user_id === BENGU.id ? 'Bengü' : (r.created_by_user_id || 'NULL');
    console.log(`    ${who}: ${r.cnt}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API Tests
// ─────────────────────────────────────────────────────────────────────────────
async function apiTests() {
  console.log('\n=== API TESTS ===\n');

  const suerToken  = makeToken(SUER);
  const elifToken  = makeToken(ELIF);
  const benguToken = makeToken(BENGU);

  const endpoints = [
    { name: 'Campaigns', path: '/api/campaigns', countFn: d => (Array.isArray(d) ? d.length : 0) },
    { name: 'Lists', path: '/api/lists', countFn: d => (d.lists || d || []).length },
    { name: 'Intents', path: '/api/intents', countFn: d => d.total || (d.intents || []).length },
    { name: 'Actions', path: '/api/actions', countFn: d => (d.items || d || []).length },
    { name: 'Mining Jobs', path: '/api/mining/jobs', countFn: d => (d.jobs || []).length },
  ];

  const users = [
    { name: 'Suer (owner)', token: suerToken },
    { name: 'Elif (manager)', token: elifToken },
    { name: 'Bengü (sales_rep)', token: benguToken },
  ];

  // Print results table
  const results = {};
  for (const ep of endpoints) {
    results[ep.name] = {};
    for (const u of users) {
      const res = await apiFetch(ep.path, u.token);
      if (res.status === 200) {
        results[ep.name][u.name] = ep.countFn(res.data);
      } else {
        results[ep.name][u.name] = `ERR:${res.status}`;
      }
    }
  }

  // Format table
  const colW = 18;
  const nameW = 14;
  console.log('  ' + 'Endpoint'.padEnd(nameW) + users.map(u => u.name.padStart(colW)).join(''));
  console.log('  ' + '-'.repeat(nameW + colW * users.length));
  for (const ep of endpoints) {
    let line = '  ' + ep.name.padEnd(nameW);
    for (const u of users) {
      const val = results[ep.name][u.name];
      line += String(val).padStart(colW);
    }
    console.log(line);
  }

  console.log('\n  Expected:');
  console.log('    Owner sees ALL rows');
  console.log('    Manager sees own + team (Elif + Bengü)');
  console.log('    Sales_rep sees own only (Bengü)');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  try {
    if (SETUP) await setup();
    await dbAudit();
    if (!DB_ONLY) await apiTests();
    console.log('\n=== DONE ===\n');
  } catch (err) {
    console.error('Fatal:', err);
  }
  process.exit(0);
}

main();
