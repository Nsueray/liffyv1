const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// TODO: Move JWT secret into .env in production
const JWT_SECRET = "liffy_secret_key_change_me";

/**
 * REGISTER
 * Creates organizer + owner user + default sender identity
 */
router.post('/api/auth/register', async (req, res) => {
  try {
    const {
      organizer_name,
      organizer_slug,
      organizer_phone,
      organizer_country,
      organizer_timezone,
      sendgrid_api_key,
      default_from_email,
      default_from_name,
      user_email,
      user_password,
      sender_label
    } = req.body;

    if (
      !organizer_name ||
      !user_email ||
      !user_password ||
      !sendgrid_api_key ||
      !default_from_email ||
      !default_from_name
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Hash password
    const password_hash = await bcrypt.hash(user_password, 10);

    // 1) ORGANIZER
    const orgResult = await db.query(
      `INSERT INTO organizers
       (name, slug, phone, country, timezone, sendgrid_api_key, default_from_email, default_from_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        organizer_name,
        organizer_slug,
        organizer_phone,
        organizer_country,
        organizer_timezone,
        sendgrid_api_key,
        default_from_email,
        default_from_name
      ]
    );
    const organizer = orgResult.rows[0];

    // 2) USER (owner)
    const userResult = await db.query(
      `INSERT INTO users
       (organizer_id, email, password_hash, role)
       VALUES ($1,$2,$3,'owner')
       RETURNING *`,
      [organizer.id, user_email, password_hash]
    );
    const user = userResult.rows[0];

    // 3) SENDER IDENTITY (default from address)
    await db.query(
      `INSERT INTO sender_identities
       (organizer_id, user_id, label, from_name, from_email, is_default)
       VALUES ($1,$2,$3,$4,$5,true)`,
      [
        organizer.id,
        user.id,
        sender_label || "Default Sender",
        default_from_name,
        default_from_email
      ]
    );

    // 4) JWT TOKEN
    const token = jwt.sign(
      {
        user_id: user.id,
        organizer_id: organizer.id,
        role: user.role
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      success: true,
      organizer_id: organizer.id,
      user_id: user.id,
      token
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * LOGIN
 * Existing user logs in with email + password
 * Returns a JWT token
 */
router.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    // Find user
    const userResult = await db.query(
      `SELECT u.*, o.id as organizer_id
       FROM users u
       JOIN organizers o ON u.organizer_id = o.id
       WHERE u.email = $1`,
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const user = userResult.rows[0];

    // Check password
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: "User is inactive" });
    }

    // Generate token
    const token = jwt.sign(
      {
        user_id: user.id,
        organizer_id: user.organizer_id,
        role: user.role
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      success: true,
      organizer_id: user.organizer_id,
      user_id: user.id,
      role: user.role,
      token
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * AUTH / ME
 * Verify token and return user + organizer info
 */
router.get('/api/auth/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ error: "Missing Authorization header" });
    }

    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) {
      return res.status(401).json({ error: "Invalid token format" });
    }

    // Verify token
    const payload = jwt.verify(token, JWT_SECRET);

    // Fetch user + organizer
    const result = await db.query(
      `SELECT 
         u.id AS user_id,
         u.email AS user_email,
         u.role AS user_role,
         u.is_active AS user_is_active,
         o.id AS organizer_id,
         o.name AS organizer_name,
         o.slug AS organizer_slug,
         o.phone AS organizer_phone,
         o.country AS organizer_country,
         o.timezone AS organizer_timezone,
         o.default_from_email AS organizer_default_from_email,
         o.default_from_name AS organizer_default_from_name
       FROM users u
       JOIN organizers o ON u.organizer_id = o.id
       WHERE u.id = $1`,
      [payload.user_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const row = result.rows[0];

    return res.json({
      success: true,
      user: {
        id: row.user_id,
        email: row.user_email,
        role: row.user_role,
        is_active: row.user_is_active
      },
      organizer: {
        id: row.organizer_id,
        name: row.organizer_name,
        slug: row.organizer_slug,
        phone: row.organizer_phone,
        country: row.organizer_country,
        timezone: row.organizer_timezone,
        default_from_email: row.organizer_default_from_email,
        default_from_name: row.organizer_default_from_name
      }
    });

  } catch (err) {
    console.error(err);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
});

module.exports = router;
