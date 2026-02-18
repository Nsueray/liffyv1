const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');
const { getAccessToken, testConnection } = require('../services/zohoService');

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
      `SELECT sendgrid_api_key, zerobounce_api_key, zoho_client_id, zoho_datacenter
       FROM organizers WHERE id = $1`,
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

    const zohoClientId = result.rows[0].zoho_client_id || '';
    let maskedZohoClientId = '';
    if (zohoClientId && zohoClientId.length > 5) {
      maskedZohoClientId = '...' + zohoClientId.slice(-4);
    }

    res.json({
      settings: {
        has_api_key: !!apiKey,
        masked_api_key: maskedKey,
        has_zerobounce_key: !!zbKey,
        masked_zerobounce_key: maskedZbKey,
        has_zoho: !!zohoClientId,
        zoho_datacenter: result.rows[0].zoho_datacenter || 'com',
        masked_zoho_client_id: maskedZohoClientId
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

// PUT /api/settings/zoho - Save Zoho CRM OAuth2 credentials (validate before save)
router.put('/zoho', authRequired, async (req, res) => {
  try {
    const { organizer_id } = req.auth;
    const { client_id, client_secret, refresh_token, datacenter } = req.body;

    if (!client_id || !client_secret || !refresh_token) {
      return res.status(400).json({ error: "client_id, client_secret, and refresh_token are required" });
    }

    const dc = datacenter || 'com';
    const validDatacenters = ['com', 'eu', 'in', 'com.au', 'jp', 'ca'];
    if (!validDatacenters.includes(dc)) {
      return res.status(400).json({ error: `Invalid datacenter. Must be one of: ${validDatacenters.join(', ')}` });
    }

    // Save credentials first (needed for getAccessToken to work)
    await db.query(
      `UPDATE organizers
       SET zoho_client_id = $1, zoho_client_secret = $2, zoho_refresh_token = $3,
           zoho_datacenter = $4, zoho_access_token = NULL, zoho_access_token_expires_at = NULL
       WHERE id = $5`,
      [client_id.trim(), client_secret.trim(), refresh_token.trim(), dc, organizer_id]
    );

    // Validate by getting a token and testing connection
    const connResult = await testConnection(organizer_id);

    if (!connResult.success) {
      // Credentials invalid — clear them
      await db.query(
        `UPDATE organizers
         SET zoho_client_id = NULL, zoho_client_secret = NULL, zoho_refresh_token = NULL,
             zoho_access_token = NULL, zoho_access_token_expires_at = NULL
         WHERE id = $1`,
        [organizer_id]
      );
      return res.status(400).json({ error: connResult.error });
    }

    res.json({ success: true, org_name: connResult.org_name });
  } catch (err) {
    console.error("PUT /api/settings/zoho error:", err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/settings/zoho - Remove Zoho CRM credentials
router.delete('/zoho', authRequired, async (req, res) => {
  try {
    const { organizer_id } = req.auth;

    await db.query(
      `UPDATE organizers
       SET zoho_client_id = NULL, zoho_client_secret = NULL, zoho_refresh_token = NULL,
           zoho_access_token = NULL, zoho_access_token_expires_at = NULL, zoho_datacenter = 'com'
       WHERE id = $1`,
      [organizer_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/settings/zoho error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
