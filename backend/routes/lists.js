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
    conditions.push(`(source_ref ILIKE $${paramIndex} OR source_type ILIKE $${paramIndex})`);
    params.push(`%${mining_job_id.trim()}%`);
    paramIndex++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return { whereClause, params, paramIndex };
}

router.get('/', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;

    const result = await db.query(
      `
      SELECT 
        l.id,
        l.name,
        l.created_at,
        COUNT(lm.id) AS total_leads,
        COUNT(CASE WHEN p.verification_status = 'valid' THEN 1 END) AS verified_count,
        COUNT(CASE WHEN lm.id IS NOT NULL AND (p.verification_status IS NULL OR p.verification_status != 'valid') THEN 1 END) AS unverified_count
      FROM lists l
      LEFT JOIN list_members lm ON lm.list_id = l.id
      LEFT JOIN prospects p ON p.id = lm.prospect_id
      WHERE l.organizer_id = $1
      GROUP BY l.id, l.name, l.created_at
      ORDER BY l.created_at DESC
      `,
      [organizerId]
    );

    res.json({
      lists: result.rows.map(row => ({
        id: row.id,
        name: row.name,
        created_at: row.created_at,
        total_leads: parseInt(row.total_leads, 10) || 0,
        verified_count: parseInt(row.verified_count, 10) || 0,
        unverified_count: parseInt(row.unverified_count, 10) || 0
      }))
    });
  } catch (err) {
    console.error('GET /api/lists error:', err);
    res.status(500).json({ error: 'Failed to fetch lists' });
  }
});

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

router.post('/preview', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const filters = req.body || {};

    console.log('Preview filters received:', JSON.stringify(filters));

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
    console.log('Preview query:', query);
    console.log('Preview params:', params);

    const result = await db.query(query, params);
    const count = parseInt(result.rows[0].count, 10) || 0;

    res.json({ count });
  } catch (err) {
    console.error('POST /api/lists/preview error:', err);
    res.status(500).json({ error: err.message || 'Failed to preview leads' });
  }
});

router.post('/create-with-filters', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const { name, ...filters } = req.body || {};

    console.log('Create list request:', { name, filters: JSON.stringify(filters) });

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
      INSERT INTO list_members (list_id, prospect_id)
      SELECT $${paramIndex}, id FROM prospects ${whereClause}
      ON CONFLICT (list_id, prospect_id) DO NOTHING
    `;

    console.log('Insert query:', insertQuery);
    console.log('Insert params:', [...params, newList.id]);

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
