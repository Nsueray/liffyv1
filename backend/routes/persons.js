const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');

const { generateExport } = require('../utils/exportHelper');
const { getHierarchicalScope, canAccessRowHierarchical } = require('../middleware/userScope');

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

// GET /api/persons — List persons with pagination, search, filtering
router.get('/', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;

    const { search, verification_status, country, company, has_intent, industry } = req.query;

    let where = ['p.organizer_id = $1'];
    const params = [organizerId];
    let idx = 2;

    if (search && search.trim()) {
      where.push(`(
        LOWER(p.email) LIKE LOWER($${idx}) OR
        LOWER(p.first_name) LIKE LOWER($${idx}) OR
        LOWER(p.last_name) LIKE LOWER($${idx}) OR
        LOWER(a.company_name) LIKE LOWER($${idx})
      )`);
      params.push(`%${search.trim()}%`);
      idx++;
    }

    if (verification_status && verification_status !== 'all') {
      if (verification_status === 'exclude_invalid') {
        where.push(`(p.verification_status IS NULL OR p.verification_status NOT IN ('invalid', 'risky'))`);
      } else {
        where.push(`p.verification_status = $${idx}`);
        params.push(verification_status.trim());
        idx++;
      }
    }

    if (country && country.trim()) {
      where.push(`LOWER(a.country_code) = LOWER($${idx})`);
      params.push(country.trim());
      idx++;
    }

    if (company && company.trim()) {
      where.push(`LOWER(a.company_name) LIKE LOWER($${idx})`);
      params.push(`%${company.trim()}%`);
      idx++;
    }

    if (industry && industry.trim()) {
      where.push(`EXISTS (
        SELECT 1 FROM affiliations af
        WHERE af.person_id = p.id AND af.organizer_id = p.organizer_id
          AND af.industry = $${idx}
      )`);
      params.push(industry.trim());
      idx++;
    }

    if (has_intent === 'true') {
      where.push(`EXISTS (
        SELECT 1 FROM prospect_intents pi
        WHERE pi.person_id = p.id AND pi.organizer_id = p.organizer_id
      )`);
    } else if (has_intent === 'false') {
      where.push(`NOT EXISTS (
        SELECT 1 FROM prospect_intents pi
        WHERE pi.person_id = p.id AND pi.organizer_id = p.organizer_id
      )`);
    }

    // User scope: sales_owner_user_id hierarchy (owner/admin sees all)
    const scope = getHierarchicalScope(req, 'p.sales_owner_user_id', idx);
    idx = scope.nextIndex;

    const whereClause = where.join(' AND ');

    // Count total
    const countRes = await db.query(
      `SELECT COUNT(DISTINCT p.id)
       FROM persons p
       LEFT JOIN LATERAL (
         SELECT company_name, position, country_code, city, website, phone
         FROM affiliations
         WHERE person_id = p.id AND organizer_id = p.organizer_id
           AND (company_name IS NULL OR company_name NOT LIKE '%@%')
         ORDER BY created_at DESC LIMIT 1
       ) a ON true
       WHERE ${whereClause} ${scope.sql}`,
      [...params, ...scope.params]
    );
    const total = parseInt(countRes.rows[0].count, 10);

    // Fetch page
    const dataRes = await db.query(
      `SELECT
         p.id,
         p.email,
         p.first_name,
         p.last_name,
         p.verification_status,
         p.verified_at,
         p.created_at,
         p.updated_at,
         CASE
           WHEN a.company_name LIKE '%|%' THEN NULLIF(TRIM(SPLIT_PART(a.company_name, '|', 1)), '')
           ELSE a.company_name
         END AS company_name,
         a.position,
         a.country_code,
         a.city,
         a.website,
         a.phone,
         a.industry,
         EXISTS (
           SELECT 1 FROM prospect_intents pi
           WHERE pi.person_id = p.id AND pi.organizer_id = p.organizer_id
         ) AS has_intent
       FROM persons p
       LEFT JOIN LATERAL (
         SELECT company_name, position, country_code, city, website, phone, industry
         FROM affiliations
         WHERE person_id = p.id AND organizer_id = p.organizer_id
           AND (company_name IS NULL OR company_name NOT LIKE '%@%')
         ORDER BY created_at DESC LIMIT 1
       ) a ON true
       WHERE ${whereClause} ${scope.sql}
       ORDER BY p.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, ...scope.params, limit, offset]
    );

    res.json({
      total,
      page,
      limit,
      persons: dataRes.rows
    });
  } catch (err) {
    console.error('GET /api/persons error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/persons/industries — Distinct industry list for dropdown filter
router.get('/industries', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;

    const result = await db.query(
      `SELECT af.industry, COUNT(DISTINCT af.person_id) AS contact_count
       FROM affiliations af
       WHERE af.organizer_id = $1 AND af.industry IS NOT NULL AND af.industry != ''
       GROUP BY af.industry
       ORDER BY contact_count DESC`,
      [organizerId]
    );

    res.json({ industries: result.rows });
  } catch (err) {
    console.error('GET /api/persons/industries error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/persons/companies — Distinct company list for autocomplete
router.get('/companies', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const q = req.query.q || '';

    let where = `af.organizer_id = $1
      AND af.company_name IS NOT NULL
      AND af.company_name != ''
      AND af.company_name NOT LIKE '%@%'`;
    const params = [organizerId];
    let idx = 2;

    if (q.trim()) {
      where += ` AND LOWER(af.company_name) LIKE LOWER($${idx})`;
      params.push(`%${q.trim()}%`);
      idx++;
    }

    const result = await db.query(
      `SELECT af.company_name, COUNT(DISTINCT af.person_id) AS contact_count
       FROM affiliations af
       WHERE ${where}
       GROUP BY af.company_name
       ORDER BY contact_count DESC, af.company_name ASC
       LIMIT 50`,
      params
    );

    res.json({ companies: result.rows });
  } catch (err) {
    console.error('GET /api/persons/companies error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/persons/stats — Quick counts for dashboard
router.get('/stats', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;

    const statsRes = await db.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE verification_status = 'valid') AS verified,
         COUNT(*) FILTER (WHERE verification_status = 'invalid') AS invalid,
         COUNT(*) FILTER (WHERE verification_status IS NULL OR verification_status IN ('unknown', 'catchall')) AS unverified
       FROM persons
       WHERE organizer_id = $1`,
      [organizerId]
    );

    const intentRes = await db.query(
      `SELECT COUNT(DISTINCT pi.person_id) AS with_intent
       FROM prospect_intents pi
       WHERE pi.organizer_id = $1`,
      [organizerId]
    );

    const stats = statsRes.rows[0];

    res.json({
      total: parseInt(stats.total, 10) || 0,
      verified: parseInt(stats.verified, 10) || 0,
      invalid: parseInt(stats.invalid, 10) || 0,
      unverified: parseInt(stats.unverified, 10) || 0,
      with_intent: parseInt(intentRes.rows[0].with_intent, 10) || 0
    });
  } catch (err) {
    console.error('GET /api/persons/stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/persons/export — Export all contacts as XLSX or CSV
router.get('/export', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const format = (req.query.format || 'xlsx').toLowerCase();

    if (!['xlsx', 'csv'].includes(format)) {
      return res.status(400).json({ error: 'Invalid format. Use xlsx or csv.' });
    }

    // Reuse same filter logic from GET /
    const { search, verification_status, country, company, has_intent } = req.query;
    let where = ['p.organizer_id = $1'];
    const params = [organizerId];
    let idx = 2;

    if (search && search.trim()) {
      where.push(`(
        LOWER(p.email) LIKE LOWER($${idx}) OR
        LOWER(p.first_name) LIKE LOWER($${idx}) OR
        LOWER(p.last_name) LIKE LOWER($${idx}) OR
        LOWER(a.company_name) LIKE LOWER($${idx})
      )`);
      params.push(`%${search.trim()}%`);
      idx++;
    }

    if (verification_status && verification_status !== 'all') {
      if (verification_status === 'exclude_invalid') {
        where.push(`(p.verification_status IS NULL OR p.verification_status NOT IN ('invalid', 'risky'))`);
      } else {
        where.push(`p.verification_status = $${idx}`);
        params.push(verification_status.trim());
        idx++;
      }
    }

    if (country && country.trim()) {
      where.push(`LOWER(a.country_code) = LOWER($${idx})`);
      params.push(country.trim());
      idx++;
    }

    if (company && company.trim()) {
      where.push(`LOWER(a.company_name) LIKE LOWER($${idx})`);
      params.push(`%${company.trim()}%`);
      idx++;
    }

    if (has_intent === 'true') {
      where.push(`EXISTS (
        SELECT 1 FROM prospect_intents pi
        WHERE pi.person_id = p.id AND pi.organizer_id = p.organizer_id
      )`);
    } else if (has_intent === 'false') {
      where.push(`NOT EXISTS (
        SELECT 1 FROM prospect_intents pi
        WHERE pi.person_id = p.id AND pi.organizer_id = p.organizer_id
      )`);
    }

    // User scope: sales_owner_user_id hierarchy (owner/admin sees all)
    const scope = getHierarchicalScope(req, 'p.sales_owner_user_id', idx);
    idx = scope.nextIndex;

    const whereClause = where.join(' AND ');

    // Use CTEs to pre-aggregate engagement stats instead of correlated subqueries (75K+ persons)
    const dataRes = await db.query(
      `WITH engagement AS (
        SELECT
          cr.email,
          cr.organizer_id,
          COUNT(*) AS campaigns_sent,
          COUNT(CASE WHEN ce.event_type = 'open' THEN 1 END) AS opens,
          COUNT(CASE WHEN ce.event_type = 'click' THEN 1 END) AS clicks,
          COUNT(CASE WHEN ce.event_type = 'reply' THEN 1 END) AS replies,
          COUNT(CASE WHEN ce.event_type = 'bounce' THEN 1 END) AS bounces
        FROM campaign_recipients cr
        LEFT JOIN campaign_events ce ON ce.recipient_id = cr.id
        WHERE cr.organizer_id = $1
        GROUP BY cr.email, cr.organizer_id
      ),
      last_camp AS (
        SELECT DISTINCT ON (cr.email)
          cr.email, cr.organizer_id, c.name AS last_campaign
        FROM campaign_recipients cr
        JOIN campaigns c ON c.id = cr.campaign_id
        WHERE cr.organizer_id = $1
        ORDER BY cr.email, cr.created_at DESC
      ),
      person_lists AS (
        SELECT lm.person_id, STRING_AGG(DISTINCT l.name, ', ') AS lists
        FROM list_members lm
        JOIN lists l ON l.id = lm.list_id
        WHERE l.organizer_id = $1 AND lm.person_id IS NOT NULL
        GROUP BY lm.person_id
      ),
      person_intent AS (
        SELECT DISTINCT ON (pi.person_id)
          pi.person_id, pi.intent_type
        FROM prospect_intents pi
        WHERE pi.organizer_id = $1
        ORDER BY pi.person_id, pi.created_at DESC
      )
      SELECT
        p.email,
        p.first_name,
        p.last_name,
        CASE
          WHEN a.company_name LIKE '%|%' THEN NULLIF(TRIM(SPLIT_PART(a.company_name, '|', 1)), '')
          ELSE a.company_name
        END AS company,
        a.position AS job_title,
        a.phone,
        a.website,
        a.country_code AS country,
        a.city,
        p.verification_status,
        p.verified_at,
        p.created_at,
        COALESCE(e.campaigns_sent, 0) AS campaigns_sent,
        COALESCE(e.opens, 0) AS opens,
        COALESCE(e.clicks, 0) AS clicks,
        COALESCE(e.replies, 0) AS replies,
        COALESCE(e.bounces, 0) AS bounces,
        lc.last_campaign,
        pi.intent_type IS NOT NULL AS is_prospect,
        pi.intent_type AS latest_intent,
        pl.lists
      FROM persons p
      LEFT JOIN LATERAL (
        SELECT company_name, position, country_code, city, website, phone
        FROM affiliations
        WHERE person_id = p.id AND organizer_id = p.organizer_id
          AND (company_name IS NULL OR company_name NOT LIKE '%@%')
        ORDER BY created_at DESC LIMIT 1
      ) a ON true
      LEFT JOIN engagement e ON e.email = p.email AND e.organizer_id = p.organizer_id
      LEFT JOIN last_camp lc ON lc.email = p.email AND lc.organizer_id = p.organizer_id
      LEFT JOIN person_lists pl ON pl.person_id = p.id
      LEFT JOIN person_intent pi ON pi.person_id = p.id
      WHERE ${whereClause} ${scope.sql}
      ORDER BY p.created_at DESC`,
      [...params, ...scope.params]
    );

    const rows = dataRes.rows.map(r => ({
      ...r,
      is_prospect: r.is_prospect ? 'Yes' : 'No',
      verified_at: r.verified_at ? new Date(r.verified_at).toISOString().split('T')[0] : '',
      created_at: r.created_at ? new Date(r.created_at).toISOString().split('T')[0] : ''
    }));

    const columns = [
      { header: 'Email', key: 'email', width: 30 },
      { header: 'First Name', key: 'first_name', width: 16 },
      { header: 'Last Name', key: 'last_name', width: 16 },
      { header: 'Company', key: 'company', width: 25 },
      { header: 'Job Title', key: 'job_title', width: 22 },
      { header: 'Phone', key: 'phone', width: 18 },
      { header: 'Website', key: 'website', width: 25 },
      { header: 'Country', key: 'country', width: 12 },
      { header: 'City', key: 'city', width: 15 },
      { header: 'Verification', key: 'verification_status', width: 14 },
      { header: 'Verified At', key: 'verified_at', width: 14 },
      { header: 'Added', key: 'created_at', width: 14 },
      { header: 'Campaigns Sent', key: 'campaigns_sent', width: 14 },
      { header: 'Opens', key: 'opens', width: 10 },
      { header: 'Clicks', key: 'clicks', width: 10 },
      { header: 'Replies', key: 'replies', width: 10 },
      { header: 'Bounces', key: 'bounces', width: 10 },
      { header: 'Last Campaign', key: 'last_campaign', width: 22 },
      { header: 'Is Prospect', key: 'is_prospect', width: 12 },
      { header: 'Latest Intent', key: 'latest_intent', width: 18 },
      { header: 'Lists', key: 'lists', width: 25 }
    ];

    const buffer = await generateExport(rows, columns, 'Contacts', format);
    const ext = format === 'csv' ? 'csv' : 'xlsx';
    const contentType = format === 'csv'
      ? 'text/csv'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="contacts-export.${ext}"`);
    return res.send(buffer);
  } catch (err) {
    console.error('GET /api/persons/export error:', err);
    return res.status(500).json({ error: 'Export failed' });
  }
});

// GET /api/persons/:id/campaigns — campaign history for this person
router.get('/:id/campaigns', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const personId = req.params.id;

    // Verify person exists and user has access via sales_owner hierarchy
    const scope = getHierarchicalScope(req, 'p.sales_owner_user_id', 3);

    const personCheck = await db.query(
      `SELECT p.id FROM persons p WHERE p.id = $1 AND p.organizer_id = $2 ${scope.sql}`,
      [personId, organizerId, ...scope.params]
    );

    if (personCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Person not found' });
    }

    const result = await db.query(
      `SELECT c.id, c.name, c.status, c.created_at,
         COUNT(CASE WHEN ce.event_type = 'sent' THEN 1 END)::int AS sent,
         COUNT(CASE WHEN ce.event_type = 'delivered' THEN 1 END)::int AS delivered,
         COUNT(CASE WHEN ce.event_type = 'open' THEN 1 END)::int AS opens,
         COUNT(CASE WHEN ce.event_type = 'click' THEN 1 END)::int AS clicks,
         COUNT(CASE WHEN ce.event_type = 'reply' THEN 1 END)::int AS replies,
         COUNT(CASE WHEN ce.event_type = 'bounce' THEN 1 END)::int AS bounces
       FROM campaign_events ce
       JOIN campaigns c ON c.id = ce.campaign_id
       WHERE ce.person_id = $1 AND ce.organizer_id = $2
       GROUP BY c.id, c.name, c.status, c.created_at
       ORDER BY c.created_at DESC`,
      [personId, organizerId]
    );

    res.json({ campaigns: result.rows });
  } catch (err) {
    console.error('GET /api/persons/:id/campaigns error:', err);
    res.status(500).json({ error: 'Failed to fetch campaign history' });
  }
});

// GET /api/persons/:id — Single person detail with all affiliations
router.get('/:id', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const personId = req.params.id;

    const scope = getHierarchicalScope(req, 'p.sales_owner_user_id', 3);

    const personRes = await db.query(
      `SELECT id, email, first_name, last_name, verification_status, verified_at, sales_owner_user_id, created_at, updated_at
       FROM persons p
       WHERE p.id = $1 AND p.organizer_id = $2 ${scope.sql}`,
      [personId, organizerId, ...scope.params]
    );

    if (personRes.rows.length === 0) {
      return res.status(404).json({ error: 'Person not found' });
    }

    const person = personRes.rows[0];

    // Get all affiliations (clean pipe-separated and email company names)
    const affRes = await db.query(
      `SELECT id,
         CASE
           WHEN company_name LIKE '%|%' THEN NULLIF(TRIM(SPLIT_PART(company_name, '|', 1)), '')
           WHEN company_name LIKE '%@%' THEN NULL
           ELSE company_name
         END AS company_name,
         position, country_code, city, website, phone, source_type, source_ref, created_at
       FROM affiliations
       WHERE person_id = $1 AND organizer_id = $2
       ORDER BY created_at DESC`,
      [personId, organizerId]
    );

    // Get intent signals
    const intentRes = await db.query(
      `SELECT id, intent_type, campaign_id, source, notes, confidence, occurred_at, created_at
       FROM prospect_intents
       WHERE person_id = $1 AND organizer_id = $2
       ORDER BY occurred_at DESC
       LIMIT 20`,
      [personId, organizerId]
    );

    // Get campaign events summary
    const eventsRes = await db.query(
      `SELECT event_type, COUNT(*) AS count, MAX(occurred_at) AS last_at
       FROM campaign_events
       WHERE email = $1 AND organizer_id = $2
       GROUP BY event_type
       ORDER BY count DESC`,
      [person.email, organizerId]
    );

    // Get Zoho push status
    const zohoRes = await db.query(
      `SELECT zoho_module, zoho_record_id, action, status, pushed_at
       FROM zoho_push_log
       WHERE person_id = $1 AND organizer_id = $2 AND status = 'success'
       ORDER BY pushed_at DESC
       LIMIT 5`,
      [personId, organizerId]
    );

    res.json({
      person,
      affiliations: affRes.rows,
      intents: intentRes.rows,
      engagement: eventsRes.rows,
      zoho_pushes: zohoRes.rows
    });
  } catch (err) {
    console.error('GET /api/persons/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/persons/:id/affiliations — Person's affiliations
router.get('/:id/affiliations', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const personId = req.params.id;

    // Verify person exists and user has access via sales_owner hierarchy
    const scope = getHierarchicalScope(req, 'p.sales_owner_user_id', 3);

    const personRes = await db.query(
      `SELECT p.id FROM persons p WHERE p.id = $1 AND p.organizer_id = $2 ${scope.sql}`,
      [personId, organizerId, ...scope.params]
    );

    if (personRes.rows.length === 0) {
      return res.status(404).json({ error: 'Person not found' });
    }

    const affRes = await db.query(
      `SELECT id,
         CASE
           WHEN company_name LIKE '%|%' THEN NULLIF(TRIM(SPLIT_PART(company_name, '|', 1)), '')
           WHEN company_name LIKE '%@%' THEN NULL
           ELSE company_name
         END AS company_name,
         position, country_code, city, website, phone, source_type, source_ref, created_at
       FROM affiliations
       WHERE person_id = $1 AND organizer_id = $2
       ORDER BY created_at DESC`,
      [personId, organizerId]
    );

    res.json({ affiliations: affRes.rows });
  } catch (err) {
    console.error('GET /api/persons/:id/affiliations error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/persons — Create a single person (manual entry by salesperson)
// sales_owner_user_id defaults to creating user. Optional override with hierarchy check.
// ON CONFLICT: do NOT overwrite existing owner.
router.post('/', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const userId = req.auth.user_id;
    const { email, first_name, last_name, verification_status, sales_owner_user_id: requestedOwner } = req.body || {};

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    const trimmedEmail = email.trim().toLowerCase();

    // Determine owner: explicit or default to creator
    let ownerId = userId;
    if (requestedOwner) {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(requestedOwner)) {
        return res.status(400).json({ error: 'Invalid sales_owner_user_id format' });
      }
      // Verify target user exists and belongs to same organizer
      const targetUser = await db.query(
        `SELECT id FROM users WHERE id = $1 AND organizer_id = $2`,
        [requestedOwner, organizerId]
      );
      if (targetUser.rows.length === 0) {
        return res.status(400).json({ error: 'Target user not found in this organization' });
      }
      // Hierarchy check: can creator assign to this user?
      if (!(await canAccessRowHierarchical(req, requestedOwner))) {
        return res.status(403).json({ error: 'Bu kullanıcıya atama yetkiniz yok' });
      }
      ownerId = requestedOwner;
    }

    // Check if person already exists in this org
    const existing = await db.query(
      `SELECT id, email, first_name, last_name, sales_owner_user_id
         FROM persons WHERE organizer_id = $1 AND LOWER(email) = $2 LIMIT 1`,
      [organizerId, trimmedEmail]
    );

    if (existing.rows.length > 0) {
      // Person exists — fill blanks but NEVER overwrite sales_owner_user_id
      const person = existing.rows[0];
      const sets = [];
      const vals = [];
      let idx = 1;

      if (!person.first_name && first_name) {
        sets.push(`first_name = $${idx++}`);
        vals.push(first_name.trim());
      }
      if (!person.last_name && last_name) {
        sets.push(`last_name = $${idx++}`);
        vals.push(last_name.trim());
      }
      if (!person.sales_owner_user_id) {
        sets.push(`sales_owner_user_id = $${idx++}`);
        vals.push(ownerId);
      }

      if (sets.length > 0) {
        sets.push(`updated_at = NOW()`);
        vals.push(person.id, organizerId);
        await db.query(
          `UPDATE persons SET ${sets.join(', ')} WHERE id = $${idx++} AND organizer_id = $${idx}`,
          vals
        );
      }

      // Re-fetch updated record
      const updated = await db.query(
        `SELECT id, email, first_name, last_name, verification_status, sales_owner_user_id, created_at
           FROM persons WHERE id = $1`,
        [person.id]
      );

      return res.status(200).json({
        person: updated.rows[0],
        created: false,
        message: person.sales_owner_user_id
          ? 'Person already exists (owned by another user — ownership preserved)'
          : 'Person already exists (ownership assigned to you)'
      });
    }

    // New person — INSERT with resolved owner
    const r = await db.query(
      `INSERT INTO persons (organizer_id, email, first_name, last_name, verification_status, sales_owner_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, first_name, last_name, verification_status, sales_owner_user_id, created_at`,
      [
        organizerId,
        trimmedEmail,
        first_name ? first_name.trim() : null,
        last_name ? last_name.trim() : null,
        verification_status || 'unverified',
        ownerId
      ]
    );

    res.status(201).json({ person: r.rows[0], created: true });
  } catch (err) {
    console.error('POST /api/persons error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/persons/:id/owner — Reassign sales_owner_user_id
// Two-sided hierarchy check: caller must access current owner AND new owner.
router.patch('/:id/owner', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const userId = req.auth.user_id;
    const personId = req.params.id;
    const { new_owner_user_id } = req.body || {};

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!new_owner_user_id || !uuidRegex.test(new_owner_user_id)) {
      return res.status(400).json({ error: 'Geçerli bir new_owner_user_id zorunlu' });
    }
    if (!uuidRegex.test(personId)) {
      return res.status(400).json({ error: 'Invalid person id' });
    }

    // Load person
    const personRes = await db.query(
      `SELECT id, email, first_name, last_name, sales_owner_user_id
         FROM persons WHERE id = $1 AND organizer_id = $2 LIMIT 1`,
      [personId, organizerId]
    );
    if (personRes.rows.length === 0) {
      return res.status(404).json({ error: 'Person not found' });
    }
    const person = personRes.rows[0];
    const fromOwner = person.sales_owner_user_id;

    // Check 1: caller can access current owner's scope
    if (fromOwner && !(await canAccessRowHierarchical(req, fromOwner))) {
      return res.status(403).json({ error: 'Bu kişiye erişim yetkiniz yok' });
    }

    // Check 2: caller can assign to new owner's scope
    if (!(await canAccessRowHierarchical(req, new_owner_user_id))) {
      return res.status(403).json({ error: 'Bu kullanıcıya atama yetkiniz yok' });
    }

    // Validate new owner exists in same org
    const targetUser = await db.query(
      `SELECT id, email, first_name, last_name FROM users WHERE id = $1 AND organizer_id = $2`,
      [new_owner_user_id, organizerId]
    );
    if (targetUser.rows.length === 0) {
      return res.status(400).json({ error: 'Hedef kullanıcı bu organizasyonda bulunamadı' });
    }

    // Update
    const updRes = await db.query(
      `UPDATE persons SET sales_owner_user_id = $1, updated_at = NOW()
        WHERE id = $2 AND organizer_id = $3
        RETURNING id, email, first_name, last_name, sales_owner_user_id`,
      [new_owner_user_id, personId, organizerId]
    );

    // Activity log (best-effort)
    try {
      await db.query(
        `INSERT INTO contact_activities
           (organizer_id, person_id, user_id, activity_type, description, meta)
         VALUES ($1, $2, $3, 'owner_change', $4, $5)`,
        [
          organizerId,
          personId,
          userId,
          `Owner changed to ${[targetUser.rows[0].first_name, targetUser.rows[0].last_name].filter(Boolean).join(' ') || targetUser.rows[0].email}`,
          JSON.stringify({
            from_owner_user_id: fromOwner || null,
            to_owner_user_id: new_owner_user_id,
            changed_by_user_id: userId,
          }),
        ]
      );
    } catch (actErr) {
      console.warn('[persons] owner_change activity insert failed:', actErr.message);
    }

    res.json({ person: updRes.rows[0] });
  } catch (err) {
    console.error('PATCH /api/persons/:id/owner error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/persons/:id — Delete person and cascade affiliations
// Access: owner + manager only. Scope: must have access to person's sales_owner_user_id.
router.delete('/:id', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const userId = req.auth.user_id;
    const role = req.auth.role;
    const personId = req.params.id;

    // Role gate: only owner and manager can delete
    if (role !== 'owner' && role !== 'admin' && role !== 'manager') {
      return res.status(403).json({ error: 'Bu işlem için yetkiniz yok' });
    }

    // Verify person exists
    const personRes = await db.query(
      `SELECT id, email, first_name, last_name, sales_owner_user_id FROM persons WHERE id = $1 AND organizer_id = $2`,
      [personId, organizerId]
    );

    if (personRes.rows.length === 0) {
      return res.status(404).json({ error: 'Person not found' });
    }

    const person = personRes.rows[0];

    // Scope: must have hierarchical access to person's sales owner
    if (person.sales_owner_user_id && !(await canAccessRowHierarchical(req, person.sales_owner_user_id))) {
      return res.status(403).json({ error: 'Bu kişiye erişim yetkiniz yok' });
    }

    // Reason required
    const reason = (req.body && req.body.reason || '').trim();
    if (!reason) {
      return res.status(400).json({ error: 'Silme sebebi zorunlu' });
    }

    // Cascade: contact_activities has ON DELETE CASCADE from persons,
    // so we only need to delete non-cascading FKs manually.
    // Delete affiliations (no cascade)
    await db.query(
      `DELETE FROM affiliations WHERE person_id = $1 AND organizer_id = $2`,
      [personId, organizerId]
    );

    // Delete from zoho_push_log (no cascade)
    await db.query(
      `DELETE FROM zoho_push_log WHERE person_id = $1 AND organizer_id = $2`,
      [personId, organizerId]
    );

    // Delete person (contact_activities cascade-deleted automatically)
    await db.query(
      `DELETE FROM persons WHERE id = $1 AND organizer_id = $2`,
      [personId, organizerId]
    );

    // Audit log: contact_activities has ON DELETE CASCADE so DB log is impossible
    // after person deletion. Log to server console (persistent in Render logs).
    console.log('[AUDIT] Person deleted:', JSON.stringify({
      person_id: personId,
      email: person.email,
      first_name: person.first_name,
      last_name: person.last_name,
      deleted_by_user_id: userId,
      reason,
      timestamp: new Date().toISOString(),
    }));

    res.json({ success: true, deleted_email: person.email });
  } catch (err) {
    console.error('DELETE /api/persons/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
