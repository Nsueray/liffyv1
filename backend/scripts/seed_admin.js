/**
 * Seed admin user (idempotent).
 *
 * Env vars:
 *   ADMIN_EMAIL       — admin user email (required)
 *   ADMIN_PASSWORD    — admin user password (required)
 *   ORGANIZER_NAME    — organizer display name (default: "Elan Expo")
 *   ORGANIZER_SLUG    — organizer slug (default: "elan-expo")
 *   DATABASE_URL      — already used by backend/db.js
 *   SENDGRID_API_KEY  — used as organizer's sendgrid_api_key if creating
 *
 * Run:
 *   ADMIN_EMAIL=you@elan-expo.com ADMIN_PASSWORD=secret123 \
 *     node backend/scripts/seed_admin.js
 */

const bcrypt = require('bcrypt');
const db = require('../db');

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const orgName = process.env.ORGANIZER_NAME || 'Elan Expo';
  const orgSlug = process.env.ORGANIZER_SLUG || 'elan-expo';
  const sendgridKey = process.env.SENDGRID_API_KEY || '';

  if (!email || !password) {
    console.error('❌ ADMIN_EMAIL and ADMIN_PASSWORD are required');
    process.exit(1);
  }

  try {
    // 1. Find or create organizer
    let orgRes = await db.query(
      `SELECT id, name FROM organizers WHERE slug = $1 LIMIT 1`,
      [orgSlug]
    );

    let organizerId;
    if (orgRes.rows.length > 0) {
      organizerId = orgRes.rows[0].id;
      console.log(`✔ Organizer exists: ${orgRes.rows[0].name} (${organizerId})`);
    } else {
      const ins = await db.query(
        `INSERT INTO organizers (name, slug, sendgrid_api_key)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [orgName, orgSlug, sendgridKey]
      );
      organizerId = ins.rows[0].id;
      console.log(`✔ Organizer created: ${orgName} (${organizerId})`);
    }

    // 2. Find or create user
    const userRes = await db.query(
      `SELECT id, email, role FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );

    if (userRes.rows.length > 0) {
      console.log(`✔ User already exists: ${email} (id: ${userRes.rows[0].id})`);
      console.log('   → Skipping. To reset password, delete the user first.');
      process.exit(0);
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const ins = await db.query(
      `INSERT INTO users (organizer_id, email, password_hash, role, is_active)
       VALUES ($1, $2, $3, 'owner', true)
       RETURNING id`,
      [organizerId, email, passwordHash]
    );

    console.log(`✔ Admin user created: ${email} (id: ${ins.rows[0].id}, role: owner)`);
    console.log('');
    console.log('Login at /login with:');
    console.log(`  email:    ${email}`);
    console.log(`  password: (the value you passed via ADMIN_PASSWORD)`);

    process.exit(0);
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
