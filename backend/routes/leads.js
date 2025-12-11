const express = require('express');
const db = require('../db');
const jwt = require('jsonwebtoken');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

function authRequired(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "Missing Authorization header" });
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const payload = jwt.verify(token, JWT_SECRET);

    req.auth = {
      user_id: payload.user_id,
      organizer_id: payload.organizer_id,
      role: payload.role
    };
    next();
  } catch (err) {
    console.error("Auth error:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

router.post('/api/leads/import', authRequired, async (req, res) => {
  try {
    let { leads } = req.body;
    const organizerId = req.auth.organizer_id;

    if (!leads) {
      return res.status(400).json({ error: "leads array required" });
    }

    if (!Array.isArray(leads)) {
      leads = [leads];
    }

    const normalized = leads
      .filter((lead) => lead && lead.email)
      .map((lead) => ({
        email: lead.email,
        name: lead.name || lead.contact_name || null,
        company: lead.company || lead.company_name || null,
        country: lead.country || null,
        sector: lead.sector || null,
        source_type: lead.source_type || lead.sourceType || 'import',
        source_ref: lead.source_ref || lead.sourceRef || 'manual',
        verification_status: lead.verification_status || lead.verificationStatus || 'unknown',
        meta: lead.meta || lead
      }));

    if (normalized.length === 0) {
      return res.status(400).json({ error: "No valid leads" });
    }

    const values = [];
    const placeholders = [];

    normalized.forEach((lead, i) => {
      const idx = i * 10;
      values.push(
        organizerId,
        lead.email,
        lead.name,
        lead.company,
        lead.country,
        lead.sector,
        lead.source_type,
        lead.source_ref,
        lead.verification_status,
        lead.meta
      );
      placeholders.push(`($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, $${idx + 8}, $${idx + 9}, $${idx + 10})`);
    });

    const result = await db.query(
      `INSERT INTO prospects
       (organizer_id, email, name, company, country, sector, source_type, source_ref, verification_status, meta)
       VALUES ${placeholders.join(',')}
       RETURNING *`,
      values
    );

    return res.json({ imported: result.rows.length, prospects: result.rows });
  } catch (err) {
    console.error("POST /api/leads/import error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/api/verification/verify', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const { emails } = req.body || {};

    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: "emails array required" });
    }

    await db.query(
      `UPDATE prospects
       SET verification_status = 'pending'
       WHERE organizer_id = $1 AND email = ANY($2::text[])`,
      [organizerId, emails]
    );

    return res.json({ started: true, count: emails.length });
  } catch (err) {
    console.error("POST /api/verification/verify error:", err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
