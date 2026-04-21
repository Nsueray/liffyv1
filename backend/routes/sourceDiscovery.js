/**
 * Source Discovery Routes
 *
 * POST /api/source-discovery         — discover sources (saves to history)
 * GET  /api/source-discovery/history  — list past searches
 * GET  /api/source-discovery/history/:id — single search detail
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../db');
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
 * Body: { keyword?, industry?, target_countries?, source_type? }
 * Response: { sources: [...], search_id, searched_at }
 */
router.post('/', authRequired, async (req, res) => {
  try {
    const { fair_name, keyword, industry, target_countries, source_type } = req.body;
    const { organizer_id, user_id } = req.auth;

    // v2: keyword is primary, fair_name is backward compat
    const searchKeyword = (keyword || fair_name || '').trim();

    // Validation — at least ONE input required
    const hasKeyword = searchKeyword.length > 0;
    const hasIndustry = industry && industry.trim().length > 0;
    const hasCountries = (Array.isArray(target_countries) && target_countries.length > 0) ||
      (typeof target_countries === 'string' && target_countries.trim().length > 0);

    if (!hasKeyword && !hasIndustry && !hasCountries) {
      return res.status(400).json({ error: 'At least one filter is required (keyword, industry, or country)' });
    }
    if (searchKeyword.length > 300) {
      return res.status(400).json({ error: 'keyword must be under 300 characters' });
    }
    if (industry && industry.length > 200) {
      return res.status(400).json({ error: 'industry must be under 200 characters' });
    }

    // Normalize target_countries
    let countries = [];
    if (Array.isArray(target_countries)) {
      countries = target_countries.filter(c => typeof c === 'string' && c.trim().length > 0);
    } else if (typeof target_countries === 'string') {
      countries = target_countries.split(',').map(c => c.trim()).filter(Boolean);
    }

    const resolvedSourceType = source_type || 'trade_fair';

    console.log(`[sourceDiscovery] POST — keyword="${searchKeyword}", type="${resolvedSourceType}", industry="${industry || ''}", countries=${countries.length}, org=${organizer_id}`);

    const result = await discoverSources({
      keyword: searchKeyword,
      industry: (industry || '').trim(),
      target_countries: countries,
      source_type: resolvedSourceType,
      organizer_id
    });

    const sources = result.sources || [];

    // Save to discovery_searches (fire-and-forget for rate_limit, save even with 0 results)
    let searchId = null;
    if (!result.error || result.error === 'rate_limit') {
      try {
        const insertResult = await db.query(
          `INSERT INTO discovery_searches (organizer_id, user_id, source_type, keyword, industry, countries, results, result_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [
            organizer_id,
            user_id || null,
            resolvedSourceType,
            searchKeyword || null,
            (industry || '').trim() || null,
            countries.length > 0 ? countries : null,
            JSON.stringify(sources),
            sources.length
          ]
        );
        searchId = insertResult.rows[0]?.id;
        console.log(`[sourceDiscovery] Saved search ${searchId}: ${sources.length} results`);
      } catch (dbErr) {
        console.error(`[sourceDiscovery] Failed to save search history: ${dbErr.message}`);
      }
    }

    const responseBody = {
      sources,
      searched_at: new Date().toISOString(),
      ...(searchId ? { search_id: searchId } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.retry_after ? { retry_after: result.retry_after } : {})
    };

    const json = JSON.stringify(responseBody);
    console.log(`[sourceDiscovery] Response: ${sources.length} sources, ${json.length} bytes`);

    res.setHeader('Content-Type', 'application/json');
    return res.send(json);
  } catch (err) {
    console.error(`[sourceDiscovery] Route error: ${err.message}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/source-discovery/history
 *
 * Returns last 50 searches for the organizer.
 * Each result URL is enriched with mining_status from mining_jobs.
 */
router.get('/history', authRequired, async (req, res) => {
  try {
    const { organizer_id } = req.auth;

    const { rows: searches } = await db.query(
      `SELECT id, source_type, keyword, industry, countries, results, result_count, created_at
       FROM discovery_searches
       WHERE organizer_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [organizer_id]
    );

    // Collect all unique URLs across all searches for batch mining status lookup
    const allUrls = new Set();
    for (const s of searches) {
      const results = s.results || [];
      for (const r of results) {
        if (r.url) allUrls.add(r.url);
      }
    }

    // Batch lookup: latest mining job per URL
    let miningMap = {};
    if (allUrls.size > 0) {
      const urlArray = Array.from(allUrls);
      const { rows: miningRows } = await db.query(
        `SELECT DISTINCT ON (input) input, id, status, total_found
         FROM mining_jobs
         WHERE organizer_id = $1 AND input = ANY($2)
         ORDER BY input, created_at DESC`,
        [organizer_id, urlArray]
      );
      for (const row of miningRows) {
        miningMap[row.input] = {
          mining_job_id: row.id,
          mining_status: row.status,
          mining_found: row.total_found || 0,
        };
      }
    }

    // Enrich results with mining status
    const enriched = searches.map(s => {
      const results = (s.results || []).map(r => ({
        ...r,
        ...(miningMap[r.url] || { mining_status: null }),
      }));
      return {
        id: s.id,
        source_type: s.source_type,
        keyword: s.keyword,
        industry: s.industry,
        countries: s.countries,
        result_count: s.result_count,
        results,
        created_at: s.created_at,
      };
    });

    return res.json({ searches: enriched });
  } catch (err) {
    console.error(`[sourceDiscovery] History error: ${err.message}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/source-discovery/history/:id
 *
 * Returns single search with enriched mining status per URL.
 */
router.get('/history/:id', authRequired, async (req, res) => {
  try {
    const { organizer_id } = req.auth;
    const { id } = req.params;

    const { rows } = await db.query(
      `SELECT id, source_type, keyword, industry, countries, results, result_count, created_at
       FROM discovery_searches
       WHERE id = $1 AND organizer_id = $2`,
      [id, organizer_id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Search not found' });
    }

    const search = rows[0];
    const results = search.results || [];

    // Mining status lookup for this search's URLs
    const urls = results.map(r => r.url).filter(Boolean);
    let miningMap = {};
    if (urls.length > 0) {
      const { rows: miningRows } = await db.query(
        `SELECT DISTINCT ON (input) input, id, status, total_found
         FROM mining_jobs
         WHERE organizer_id = $1 AND input = ANY($2)
         ORDER BY input, created_at DESC`,
        [organizer_id, urls]
      );
      for (const row of miningRows) {
        miningMap[row.input] = {
          mining_job_id: row.id,
          mining_status: row.status,
          mining_found: row.total_found || 0,
        };
      }
    }

    const enrichedResults = results.map(r => ({
      ...r,
      ...(miningMap[r.url] || { mining_status: null }),
    }));

    return res.json({
      id: search.id,
      source_type: search.source_type,
      keyword: search.keyword,
      industry: search.industry,
      countries: search.countries,
      result_count: search.result_count,
      results: enrichedResults,
      created_at: search.created_at,
    });
  } catch (err) {
    console.error(`[sourceDiscovery] History detail error: ${err.message}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
