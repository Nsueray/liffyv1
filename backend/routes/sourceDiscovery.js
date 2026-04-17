/**
 * Source Discovery Route
 *
 * POST /api/source-discovery
 * Finds B2B data sources using Claude API + web search
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { discoverSources } = require('../services/sourceDiscovery');

const JWT_SECRET = process.env.JWT_SECRET || 'liffy_secret_key_change_me';

/**
 * Auth middleware
 */
function authRequired(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing Authorization header' });
    }

    const token = authHeader.replace('Bearer ', '').trim();
    const payload = jwt.verify(token, JWT_SECRET);
    payload.user_id = payload.user_id || payload.id; // normalize legacy JWT

    req.auth = {
      user_id: payload.user_id,
      organizer_id: payload.organizer_id,
      role: payload.role,
    };

    req.user = req.auth;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * POST /api/source-discovery
 *
 * Body: { fair_name: string, industry: string, target_countries?: string[] }
 * Response: { sources: [...], searched_at: ISO timestamp }
 */
router.post('/', authRequired, async (req, res) => {
  try {
    const { fair_name, industry, target_countries } = req.body;
    const organizer_id = req.auth.organizer_id;

    // Validation
    if (!fair_name || typeof fair_name !== 'string' || fair_name.trim().length === 0) {
      return res.status(400).json({ error: 'fair_name is required' });
    }
    if (!industry || typeof industry !== 'string' || industry.trim().length === 0) {
      return res.status(400).json({ error: 'industry is required' });
    }
    if (fair_name.length > 200) {
      return res.status(400).json({ error: 'fair_name must be under 200 characters' });
    }
    if (industry.length > 200) {
      return res.status(400).json({ error: 'industry must be under 200 characters' });
    }

    // Normalize target_countries
    let countries = [];
    if (Array.isArray(target_countries)) {
      countries = target_countries.filter(c => typeof c === 'string' && c.trim().length > 0);
    } else if (typeof target_countries === 'string') {
      countries = target_countries.split(',').map(c => c.trim()).filter(Boolean);
    }

    console.log(`[sourceDiscovery] POST /api/source-discovery — fair="${fair_name}", industry="${industry}", countries=${countries.length}, organizer=${organizer_id}`);

    const result = await discoverSources({
      fair_name: fair_name.trim(),
      industry: industry.trim(),
      target_countries: countries,
      organizer_id
    });

    const responseBody = {
      sources: result.sources || [],
      searched_at: new Date().toISOString(),
      ...(result.error ? { error: result.error } : {})
    };

    // Explicit stringify to catch serialization issues and log response size
    const json = JSON.stringify(responseBody);
    console.log(`[sourceDiscovery] Response: ${responseBody.sources.length} sources, ${json.length} bytes`);

    res.setHeader('Content-Type', 'application/json');
    return res.send(json);
  } catch (err) {
    console.error(`[sourceDiscovery] Route error: ${err.message}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
