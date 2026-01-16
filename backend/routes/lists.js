const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');

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

function isValidDateString(str) {
  if (!str || typeof str !== 'string') return false;
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(str)) return false;
  const date = new Date(str);
  return !isNaN(date.getTime());
}

function buildLeadsFilter(organizerId, filters) {
  const {
    date_from,
    date_to,
    countries,
    tags,
    source_types,
    mining_job_id,
    email_only
  } = filters;

  let conditions = ['organizer_id = $1'];
  let params = [organizerId];
  let paramIndex = 2;

  if (email_only !== false) {
    conditions.push("email IS NOT NULL AND TRIM(email) != ''");
  }

  if (date_from && isValidDateString(date_from)) {
    conditions.push(`created_at >= $${paramIndex}::timestamp`);
    params.push(date_from + ' 00:00:00');
    paramIndex++;
  }

  if (date_to && isValidDateString(date_to)) {
    conditions.push(`created_at <= $${paramIndex}::timestamp`);
    params.push(date_to + ' 23:59:59');
    paramIndex++;
  }

  if (countries && Array.isArray(countries)) {
    const validCountries = countries.filter(c => c && typeof c === 'string' && c.trim());
    if (validCountries.length > 0) {
      const placeholders = validCountries.map((_, i) => `$${paramIndex + i}`).join(', ');
      conditions.push(`LOWER(TRIM(country)) IN (${placeholders})`);
      validCountries.forEach(c => params.push(c.toLowerCase().trim()));
      paramIndex += validCountries.length;
    }
  }

  if (tags && Array.isArray(tags)) {
    const validTags = tags.filter(t => t && typeof t === 'string' && t.trim()).map(t => t.toLowerCase().trim());
    if (validTags.length > 0) {
      conditions.push(`tags && $${paramIndex}::text[]`);
      params.push(validTags);
      paramIndex++;
    }
  }

  if (source_types && Array.isArray(source_types)) {
    const validSourceTypes = source_types.filter(s => s && typeof s === 'string' && s.trim());
    if (validSourceTypes.length > 0) {
      const placeholders = validSourceTypes.map((_, i) => `$${paramIndex + i}`).join(', ');
      conditions.push(`LOWER(source_type) IN (${placeholders})`);
      validSourceTypes.forEach(s => params.push(s.toLowerCase().trim()));
      paramIndex += validSourceTypes.length;
    }
  }

  if (mining_job_id && typeof mining_job_id === 'string' && mining_job_id.trim()) {
    conditions.push(`source_ref = $${paramIndex}`);
    params.push(mining_job_id.trim());
    paramIndex++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return { whereClause, params, paramIndex };
}

// GET /api/lists - Get all lists with CORRECT counts using subqueries
router.get('/', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;

    const result = await db.query(
      `
      SELECT 
        l.id,
        l.name,
        l.created_at,
        (SELECT COUNT(*) FROM list_members WHERE list_id = l.id) AS total_leads,
        (SELECT COUNT(*) FROM list_members lm 
         JOIN prospects p ON p.id = lm.prospect_id 
         WHERE lm.list_id = l.id AND p.verification_status = 'valid') AS verified_count
      FROM lists l
      WHERE l.organizer_id = $1
      ORDER BY l.created_at DESC
      `,
      [organizerId]
    );

    res.json({
      lists: result.rows.map(row => {
        const total = parseInt(row.total_leads, 10) || 0;
        const verified = parseInt(row.verified_count, 10) || 0;
        return {
          id: row.id,
          name: row.name,
          created_at: row.created_at,
          total_leads: total,
          verified_count: verified,
          unverified_count: total - verified
        };
      })
    });
  } catch (err) {
    console.error('GET /api/lists error:', err);
    res.status(500).json({ error: 'Failed to fetch lists' });
  }
});

// GET /api/lists/tags - Get unique tags
router.get('/tags', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;

    const result = await db.query(
      `
      SELECT DISTINCT unnest(tags) AS tag
      FROM prospects
      WHERE organizer_id = $1 AND tags IS NOT NULL AND array_length(tags, 1) > 0
      ORDER BY tag
      `,
      [organizerId]
    );

    res.json({
      tags: result.rows.map(r => r.tag)
    });
  } catch (err) {
    console.error('GET /api/lists/tags error:', err);
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
});

// GET /api/lists/mining-jobs - Get mining jobs for selection
router.get('/mining-jobs', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;

    // Get jobs from mining_jobs table - include name field
    const result = await db.query(
      `
      SELECT 
        id,
        name,
        target_url,
        status,
        total_found,
        created_at
      FROM mining_jobs
      WHERE organizer_id = $1
      ORDER BY created_at DESC
      LIMIT 50
      `,
      [organizerId]
    );

    // Get lead counts per job from prospects
    const leadCounts = await db.query(
      `
      SELECT source_ref, COUNT(*) as lead_count
      FROM prospects
      WHERE organizer_id = $1 AND source_ref IS NOT NULL
      GROUP BY source_ref
      `,
      [organizerId]
    );

    const countMap = new Map();
    leadCounts.rows.forEach(r => {
      countMap.set(r.source_ref, parseInt(r.lead_count, 10) || 0);
    });

    res.json({
      jobs: result.rows.map(row => {
        // Build a display name: use name if available, otherwise extract domain from URL
        let displayName = row.name;
        
        if (!displayName && row.target_url) {
          try {
            const url = new URL(row.target_url);
            displayName = url.hostname.replace('www.', '');
          } catch {
            displayName = row.target_url.substring(0, 50);
          }
        }
        
        if (!displayName) {
          displayName = `Job ${row.id.substring(0, 8)}`;
        }

        return {
          id: row.id,
          name: displayName,
          target_url: row.target_url || null,
          status: row.status || 'unknown',
          total_found: row.total_found || 0,
          created_at: row.created_at,
          lead_count: countMap.get(row.id) || countMap.get(String(row.id)) || 0
        };
      })
    });
  } catch (err) {
    console.error('GET /api/lists/mining-jobs error:', err);
    res.json({ jobs: [] });
  }
});

// POST /api/lists/preview
router.post('/preview', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const filters = req.body || {};

    const { whereClause, params } = buildLeadsFilter(organizerId, {
      date_from: filters.date_from,
      date_to: filters.date_to,
      countries: filters.countries,
      tags: filters.tags,
      source_types: filters.source_types,
      mining_job_id: filters.mining_job_id,
      email_only: filters.email_only !== false
    });

    const query = `SELECT COUNT(*) FROM prospects ${whereClause}`;
    const result = await db.query(query, params);
    const count = parseInt(result.rows[0].count, 10) || 0;

    res.json({ count });
  } catch (err) {
    console.error('POST /api/lists/preview error:', err);
    res.status(500).json({ error: err.message || 'Failed to preview leads' });
  }
});

// POST /api/lists/create-with-filters
router.post('/create-with-filters', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const { name, ...filters } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'List name is required' });
    }

    const trimmedName = name.trim();

    if (trimmedName.length > 255) {
      return res.status(400).json({ error: 'List name is too long (max 255 characters)' });
    }

    const existing = await db.query(
      'SELECT id FROM lists WHERE organizer_id = $1 AND LOWER(name) = LOWER($2)',
      [organizerId, trimmedName]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'A list with this name already exists' });
    }

    const listResult = await db.query(
      'INSERT INTO lists (organizer_id, name) VALUES ($1, $2) RETURNING id, name, created_at',
      [organizerId, trimmedName]
    );

    const newList = listResult.rows[0];

    const { whereClause, params, paramIndex } = buildLeadsFilter(organizerId, {
      date_from: filters.date_from,
      date_to: filters.date_to,
      countries: filters.countries,
      tags: filters.tags,
      source_types: filters.source_types,
      mining_job_id: filters.mining_job_id,
      email_only: filters.email_only !== false
    });

    const insertQuery = `
      INSERT INTO list_members (list_id, prospect_id, organizer_id)
      SELECT $${paramIndex}, id, $1 FROM prospects ${whereClause}
      ON CONFLICT (list_id, prospect_id) DO NOTHING
    `;

    await db.query(insertQuery, [...params, newList.id]);

    const countResult = await db.query(
      'SELECT COUNT(*) FROM list_members WHERE list_id = $1',
      [newList.id]
    );
    const totalLeads = parseInt(countResult.rows[0].count, 10) || 0;

    const verifiedResult = await db.query(
      `
      SELECT COUNT(*) FROM list_members lm
      JOIN prospects p ON p.id = lm.prospect_id
      WHERE lm.list_id = $1 AND p.verification_status = 'valid'
      `,
      [newList.id]
    );
    const verifiedCount = parseInt(verifiedResult.rows[0].count, 10) || 0;

    res.status(201).json({
      id: newList.id,
      name: newList.name,
      created_at: newList.created_at,
      total_leads: totalLeads,
      verified_count: verifiedCount,
      unverified_count: totalLeads - verifiedCount
    });
  } catch (err) {
    console.error('POST /api/lists/create-with-filters error:', err);
    res.status(500).json({ error: err.message || 'Failed to create list' });
  }
});

// POST /api/lists - Create empty list
router.post('/', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const { name } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'List name is required' });
    }

    const trimmedName = name.trim();

    const existing = await db.query(
      'SELECT id FROM lists WHERE organizer_id = $1 AND LOWER(name) = LOWER($2)',
      [organizerId, trimmedName]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'A list with this name already exists' });
    }

    const result = await db.query(
      'INSERT INTO lists (organizer_id, name) VALUES ($1, $2) RETURNING id, name, created_at',
      [organizerId, trimmedName]
    );

    const newList = result.rows[0];

    res.status(201).json({
      id: newList.id,
      name: newList.name,
      created_at: newList.created_at,
      total_leads: 0,
      verified_count: 0,
      unverified_count: 0
    });
  } catch (err) {
    console.error('POST /api/lists error:', err);
    res.status(500).json({ error: err.message || 'Failed to create list' });
  }
});

// GET /api/lists/:id - Get list detail
router.get('/:id', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const listId = req.params.id;

    const listResult = await db.query(
      'SELECT id, name, created_at FROM lists WHERE id = $1 AND organizer_id = $2',
      [listId, organizerId]
    );

    if (listResult.rows.length === 0) {
      return res.status(404).json({ error: 'List not found' });
    }

    const list = listResult.rows[0];

    const membersResult = await db.query(
      `
      SELECT 
        p.id,
        p.email,
        p.name,
        p.company,
        p.country,
        p.verification_status,
        p.source_type,
        p.tags,
        p.created_at
      FROM list_members lm
      JOIN prospects p ON p.id = lm.prospect_id
      WHERE lm.list_id = $1
      ORDER BY p.created_at DESC
      `,
      [listId]
    );

    const totalLeads = membersResult.rows.length;
    const verifiedCount = membersResult.rows.filter(r => r.verification_status === 'valid').length;

    res.json({
      id: list.id,
      name: list.name,
      created_at: list.created_at,
      total_leads: totalLeads,
      verified_count: verifiedCount,
      unverified_count: totalLeads - verifiedCount,
      members: membersResult.rows.map(row => ({
        ...row,
        tags: row.tags || []
      }))
    });
  } catch (err) {
    console.error('GET /api/lists/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch list' });
  }
});

// DELETE /api/lists/:id
router.delete('/:id', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const listId = req.params.id;

    const listCheck = await db.query(
      'SELECT id FROM lists WHERE id = $1 AND organizer_id = $2',
      [listId, organizerId]
    );

    if (listCheck.rows.length === 0) {
      return res.status(404).json({ error: 'List not found' });
    }

    await db.query('DELETE FROM list_members WHERE list_id = $1', [listId]);
    await db.query('DELETE FROM lists WHERE id = $1', [listId]);

    res.json({ success: true, deleted_id: listId });
  } catch (err) {
    console.error('DELETE /api/lists/:id error:', err);
    res.status(500).json({ error: 'Failed to delete list' });
  }
});

// DELETE /api/lists/:id/members/:prospectId
router.delete('/:id/members/:prospectId', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const { id: listId, prospectId } = req.params;

    const listCheck = await db.query(
      'SELECT id FROM lists WHERE id = $1 AND organizer_id = $2',
      [listId, organizerId]
    );

    if (listCheck.rows.length === 0) {
      return res.status(404).json({ error: 'List not found' });
    }

    await db.query(
      'DELETE FROM list_members WHERE list_id = $1 AND prospect_id = $2',
      [listId, prospectId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/lists/:id/members/:prospectId error:', err);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

module.exports = router;
// force deploy Fri Jan 16 23:17:17 +03 2026
