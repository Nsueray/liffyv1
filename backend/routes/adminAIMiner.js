const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');
const aiMinerGenerator = require('../services/aiMinerGenerator');

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

function authRequired(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No token" });
  const token = authHeader.replace("Bearer ", "").trim();
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    req.auth.user_id = req.auth.user_id || req.auth.id; // normalize legacy JWT
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// All endpoints require auth
router.use(authRequired);

// GET /api/admin/ai-miner/miners — List all generated miners
router.get('/miners', async (req, res) => {
  try {
    const { status, domain } = req.query;
    let query = `SELECT id, domain_pattern, url_pattern, miner_version, source_url,
                        ai_model, status, quality_score, success_count, failure_count,
                        total_contacts_mined, generation_tokens_used,
                        last_used_at, last_success_at, approved_at, created_at
                 FROM generated_miners WHERE 1=1`;
    const params = [];

    if (status) {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }
    if (domain) {
      params.push(`%${domain}%`);
      query += ` AND domain_pattern LIKE $${params.length}`;
    }

    query += ` ORDER BY created_at DESC`;

    const { rows } = await db.query(query, params);
    res.json({ miners: rows, total: rows.length });
  } catch (err) {
    console.error('[admin/ai-miner] List error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/ai-miner/miners/:id — Detail (including code)
router.get('/miners/:id', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM generated_miners WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Miner not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[admin/ai-miner] Detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/ai-miner/generate — Manual miner generation
router.post('/generate', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(400).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  console.log(`[admin/ai-miner] Manual generation triggered for: ${url}`);

  // Return 202 immediately — generation takes 10-30 seconds
  res.status(202).json({
    message: 'Generation started',
    url,
    note: 'Check GET /api/admin/ai-miner/miners?domain=... for result'
  });

  // Run in background
  setImmediate(() => {
    aiMinerGenerator.generateMiner(url, {
      organizerId: req.auth.organizer_id
    }).then(result => {
      if (result.success) {
        console.log(`[admin/ai-miner] Generation complete: ${result.miner.id} — ${result.results.length} contacts`);
      } else {
        console.log(`[admin/ai-miner] Generation failed: ${result.error}`);
      }
    }).catch(err => {
      console.error(`[admin/ai-miner] Generation crashed: ${err.message}`);
    });
  });
});

// POST /api/admin/ai-miner/miners/:id/approve — Approve miner
router.post('/miners/:id/approve', async (req, res) => {
  try {
    const userId = req.auth.id || req.auth.userId;
    await aiMinerGenerator.approveMiner(req.params.id, userId);
    console.log(`[admin/ai-miner] Miner ${req.params.id} approved by user ${userId}`);
    res.json({ success: true, message: 'Miner approved and activated' });
  } catch (err) {
    console.error('[admin/ai-miner] Approve error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/ai-miner/miners/:id/disable — Disable miner
router.post('/miners/:id/disable', async (req, res) => {
  try {
    const { reason } = req.body;
    await aiMinerGenerator.disableMiner(req.params.id, reason || 'Manual disable');
    console.log(`[admin/ai-miner] Miner ${req.params.id} disabled: ${reason || 'Manual disable'}`);
    res.json({ success: true, message: 'Miner disabled' });
  } catch (err) {
    console.error('[admin/ai-miner] Disable error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/ai-miner/miners/:id/test — Re-test miner
router.post('/miners/:id/test', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM generated_miners WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Miner not found' });

    const miner = rows[0];
    const url = req.body.url || miner.source_url;

    console.log(`[admin/ai-miner] Testing miner ${miner.id} on ${url}`);

    const result = await aiMinerGenerator.runGeneratedMiner(miner, url);

    res.json({
      miner_id: miner.id,
      url,
      results: result.results.length,
      executionTime: result.executionTime,
      error: result.error || null,
      sample: result.results.slice(0, 5)
    });
  } catch (err) {
    console.error('[admin/ai-miner] Test error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/ai-miner/stats — Overall statistics
router.get('/stats', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)::int as total_miners,
        COUNT(*) FILTER (WHERE status = 'active')::int as active_miners,
        COUNT(*) FILTER (WHERE status = 'pending_approval')::int as pending_miners,
        COUNT(*) FILTER (WHERE status = 'disabled' OR status = 'auto_disabled')::int as disabled_miners,
        COALESCE(SUM(success_count), 0)::int as total_successes,
        COALESCE(SUM(failure_count), 0)::int as total_failures,
        COALESCE(SUM(total_contacts_mined), 0)::int as total_contacts,
        COALESCE(SUM(generation_tokens_used), 0)::int as total_tokens,
        ROUND(AVG(quality_score), 2) as avg_quality_score
      FROM generated_miners
    `);
    res.json(rows[0]);
  } catch (err) {
    console.error('[admin/ai-miner] Stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
