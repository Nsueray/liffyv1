const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');
const { pushPersons } = require('../services/zohoService');

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

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

// POST /api/zoho/push — Push selected persons to Zoho CRM
router.post('/push', authRequired, async (req, res) => {
  try {
    const { organizer_id } = req.auth;
    const userId = req.auth.user_id || null;
    const { person_ids, module } = req.body;

    if (!person_ids || !Array.isArray(person_ids) || person_ids.length === 0) {
      return res.status(400).json({ error: 'person_ids array is required' });
    }

    if (person_ids.length > 500) {
      return res.status(400).json({ error: 'Maximum 500 persons per push request' });
    }

    const zohoModule = module || 'Leads';
    if (!['Leads', 'Contacts'].includes(zohoModule)) {
      return res.status(400).json({ error: 'module must be Leads or Contacts' });
    }

    const result = await pushPersons(organizer_id, person_ids, zohoModule, userId);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json({
      pushed: result.pushed,
      failed: result.failed,
      results: result.results
    });
  } catch (err) {
    console.error('POST /api/zoho/push error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/zoho/push-list — Push all persons from a list to Zoho CRM
router.post('/push-list', authRequired, async (req, res) => {
  try {
    const { organizer_id } = req.auth;
    const userId = req.auth.user_id || null;
    const { list_id, module } = req.body;

    if (!list_id) {
      return res.status(400).json({ error: 'list_id is required' });
    }

    const zohoModule = module || 'Leads';
    if (!['Leads', 'Contacts'].includes(zohoModule)) {
      return res.status(400).json({ error: 'module must be Leads or Contacts' });
    }

    // Resolve list members → person IDs via email join
    const membersRes = await db.query(
      `SELECT DISTINCT p.id AS person_id
       FROM list_members lm
       JOIN prospects pr ON pr.id = lm.prospect_id AND pr.organizer_id = $1
       JOIN persons p ON LOWER(p.email) = LOWER(pr.email) AND p.organizer_id = $1
       WHERE lm.list_id = $2 AND lm.organizer_id = $1`,
      [organizer_id, list_id]
    );

    if (membersRes.rows.length === 0) {
      return res.json({ pushed: 0, failed: 0, total: 0, results: [] });
    }

    const personIds = membersRes.rows.map(r => r.person_id);

    const result = await pushPersons(organizer_id, personIds, zohoModule, userId);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json({
      pushed: result.pushed,
      failed: result.failed,
      total: personIds.length,
      results: result.results
    });
  } catch (err) {
    console.error('POST /api/zoho/push-list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/zoho/push-history — Paginated push history
router.get('/push-history', authRequired, async (req, res) => {
  try {
    const { organizer_id } = req.auth;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;

    // Optional filters
    const { person_id, module: zohoModule } = req.query;

    let whereClause = 'zpl.organizer_id = $1';
    const params = [organizer_id];
    let paramIdx = 2;

    if (person_id) {
      whereClause += ` AND zpl.person_id = $${paramIdx}`;
      params.push(person_id);
      paramIdx++;
    }

    if (zohoModule && ['Leads', 'Contacts'].includes(zohoModule)) {
      whereClause += ` AND zpl.zoho_module = $${paramIdx}`;
      params.push(zohoModule);
      paramIdx++;
    }

    // Count total
    const countRes = await db.query(
      `SELECT COUNT(*) FROM zoho_push_log zpl WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countRes.rows[0].count, 10);

    // Fetch page
    const historyRes = await db.query(
      `SELECT zpl.id, zpl.person_id, p.email, zpl.zoho_module, zpl.zoho_record_id,
              zpl.action, zpl.status, zpl.error_message, zpl.pushed_at
       FROM zoho_push_log zpl
       JOIN persons p ON p.id = zpl.person_id
       WHERE ${whereClause}
       ORDER BY zpl.pushed_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    );

    res.json({
      total,
      page,
      history: historyRes.rows
    });
  } catch (err) {
    console.error('GET /api/zoho/push-history error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/zoho/push-status — Summary statistics
router.get('/push-status', authRequired, async (req, res) => {
  try {
    const { organizer_id } = req.auth;

    const statsRes = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'success') AS total_pushed,
         COUNT(*) FILTER (WHERE status = 'success' AND zoho_module = 'Leads') AS leads_pushed,
         COUNT(*) FILTER (WHERE status = 'success' AND zoho_module = 'Contacts') AS contacts_pushed,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed,
         MAX(pushed_at) FILTER (WHERE status = 'success') AS last_push_at
       FROM zoho_push_log
       WHERE organizer_id = $1`,
      [organizer_id]
    );

    const stats = statsRes.rows[0];

    res.json({
      total_pushed: parseInt(stats.total_pushed, 10) || 0,
      leads_pushed: parseInt(stats.leads_pushed, 10) || 0,
      contacts_pushed: parseInt(stats.contacts_pushed, 10) || 0,
      failed: parseInt(stats.failed, 10) || 0,
      last_push_at: stats.last_push_at || null
    });
  } catch (err) {
    console.error('GET /api/zoho/push-status error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
