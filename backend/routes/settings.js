const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

// Auth Middleware (Standart)
function authRequired(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No token" });
  const token = authHeader.replace("Bearer ", "").trim();
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// GET /api/settings - Mevcut ayarları getir
router.get('/', authRequired, async (req, res) => {
  try {
    const { organizer_id } = req.auth;
    
    // API Key'i güvenlik için maskeleyerek gönderiyoruz (son 4 hane hariç)
    const result = await db.query(
      `SELECT sendgrid_api_key, zerobounce_api_key FROM organizers WHERE id = $1`,
      [organizer_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Organizer not found" });
    }

    let apiKey = result.rows[0].sendgrid_api_key || '';
    let maskedKey = '';

    if (apiKey && apiKey.length > 5) {
      maskedKey = '...' + apiKey.slice(-4);
    }

    let zbKey = result.rows[0].zerobounce_api_key || '';
    let maskedZbKey = '';
    if (zbKey && zbKey.length > 5) {
      maskedZbKey = '...' + zbKey.slice(-4);
    }

    res.json({
      settings: {
        has_api_key: !!apiKey,
        masked_api_key: maskedKey,
        has_zerobounce_key: !!zbKey,
        masked_zerobounce_key: maskedZbKey
      }
    });

  } catch (err) {
    console.error("GET /api/settings error:", err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings/apikey - API Key güncelle
router.put('/apikey', authRequired, async (req, res) => {
  try {
    const { organizer_id } = req.auth;
    const { api_key } = req.body;

    if (!api_key || !api_key.startsWith('SG.')) {
      return res.status(400).json({ error: "Invalid SendGrid API Key format (must start with SG.)" });
    }

    await db.query(
      `UPDATE organizers SET sendgrid_api_key = $1 WHERE id = $2`,
      [api_key.trim(), organizer_id]
    );

    res.json({ success: true, message: "API Key updated successfully" });

  } catch (err) {
    console.error("PUT /api/settings/apikey error:", err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings/zerobounce-key - ZeroBounce API Key update
router.put('/zerobounce-key', authRequired, async (req, res) => {
  try {
    const { organizer_id } = req.auth;
    const { api_key } = req.body;

    if (!api_key || typeof api_key !== 'string' || api_key.trim().length < 10) {
      return res.status(400).json({ error: "Invalid ZeroBounce API key" });
    }

    const trimmedKey = api_key.trim();

    // Validate key by checking credits
    const { checkCredits } = require('../services/verificationService');
    const creditResult = await checkCredits(trimmedKey);

    if (!creditResult.success) {
      return res.status(400).json({ error: `Invalid ZeroBounce API key: ${creditResult.error}` });
    }

    await db.query(
      `UPDATE organizers SET zerobounce_api_key = $1 WHERE id = $2`,
      [trimmedKey, organizer_id]
    );

    res.json({ success: true, credits: creditResult.credits });
  } catch (err) {
    console.error("PUT /api/settings/zerobounce-key error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
