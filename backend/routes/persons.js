const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');

const { generateExport } = require('../utils/exportHelper');

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

// GET /api/persons — List persons with pagination, search, filtering
router.get('/', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;

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
       WHERE ${whereClause}`,
      params
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
         EXISTS (
           SELECT 1 FROM prospect_intents pi
           WHERE pi.person_id = p.id AND pi.organizer_id = p.organizer_id
         ) AS has_intent
       FROM persons p
       LEFT JOIN LATERAL (
         SELECT company_name, position, country_code, city, website, phone
         FROM affiliations
         WHERE person_id = p.id AND organizer_id = p.organizer_id
           AND (company_name IS NULL OR company_name NOT LIKE '%@%')
         ORDER BY created_at DESC LIMIT 1
       ) a ON true
       WHERE ${whereClause}
       ORDER BY p.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
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

    const whereClause = where.join(' AND ');

    const dataRes = await db.query(
      `SELECT
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
        (SELECT COUNT(*) FROM campaign_recipients cr WHERE cr.email = p.email AND cr.organizer_id = p.organizer_id) AS campaigns_sent,
        (SELECT COUNT(*) FROM campaign_events ce JOIN campaign_recipients cr2 ON cr2.id = ce.recipient_id WHERE cr2.email = p.email AND cr2.organizer_id = p.organizer_id AND ce.event_type = 'open') AS opens,
        (SELECT COUNT(*) FROM campaign_events ce JOIN campaign_recipients cr2 ON cr2.id = ce.recipient_id WHERE cr2.email = p.email AND cr2.organizer_id = p.organizer_id AND ce.event_type = 'click') AS clicks,
        (SELECT COUNT(*) FROM campaign_events ce JOIN campaign_recipients cr2 ON cr2.id = ce.recipient_id WHERE cr2.email = p.email AND cr2.organizer_id = p.organizer_id AND ce.event_type = 'reply') AS replies,
        (SELECT COUNT(*) FROM campaign_events ce JOIN campaign_recipients cr2 ON cr2.id = ce.recipient_id WHERE cr2.email = p.email AND cr2.organizer_id = p.organizer_id AND ce.event_type = 'bounce') AS bounces,
        (SELECT c.name FROM campaign_recipients cr3 JOIN campaigns c ON c.id = cr3.campaign_id WHERE cr3.email = p.email AND cr3.organizer_id = p.organizer_id ORDER BY cr3.created_at DESC LIMIT 1) AS last_campaign,
        EXISTS (
          SELECT 1 FROM prospect_intents pi WHERE pi.person_id = p.id AND pi.organizer_id = p.organizer_id
        ) AS is_prospect,
        (SELECT pi2.intent_type FROM prospect_intents pi2 WHERE pi2.person_id = p.id AND pi2.organizer_id = p.organizer_id ORDER BY pi2.created_at DESC LIMIT 1) AS latest_intent,
        (SELECT STRING_AGG(DISTINCT l.name, ', ') FROM list_members lm JOIN lists l ON l.id = lm.list_id JOIN prospects pr ON pr.id = lm.prospect_id WHERE LOWER(pr.email) = LOWER(p.email) AND l.organizer_id = p.organizer_id) AS lists
      FROM persons p
      LEFT JOIN LATERAL (
        SELECT company_name, position, country_code, city, website, phone
        FROM affiliations
        WHERE person_id = p.id AND organizer_id = p.organizer_id
          AND (company_name IS NULL OR company_name NOT LIKE '%@%')
        ORDER BY created_at DESC LIMIT 1
      ) a ON true
      WHERE ${whereClause}
      ORDER BY p.created_at DESC`,
      params
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

// GET /api/persons/:id — Single person detail with all affiliations
router.get('/:id', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const personId = req.params.id;

    const personRes = await db.query(
      `SELECT id, email, first_name, last_name, verification_status, verified_at, created_at, updated_at
       FROM persons
       WHERE id = $1 AND organizer_id = $2`,
      [personId, organizerId]
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

    // Verify person exists
    const personRes = await db.query(
      `SELECT id FROM persons WHERE id = $1 AND organizer_id = $2`,
      [personId, organizerId]
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

// DELETE /api/persons/:id — Delete person and cascade affiliations
router.delete('/:id', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const personId = req.params.id;

    // Verify person exists
    const personRes = await db.query(
      `SELECT id, email FROM persons WHERE id = $1 AND organizer_id = $2`,
      [personId, organizerId]
    );

    if (personRes.rows.length === 0) {
      return res.status(404).json({ error: 'Person not found' });
    }

    // Delete affiliations first (FK constraint)
    await db.query(
      `DELETE FROM affiliations WHERE person_id = $1 AND organizer_id = $2`,
      [personId, organizerId]
    );

    // Delete from zoho_push_log (FK constraint)
    await db.query(
      `DELETE FROM zoho_push_log WHERE person_id = $1 AND organizer_id = $2`,
      [personId, organizerId]
    );

    // Delete person
    await db.query(
      `DELETE FROM persons WHERE id = $1 AND organizer_id = $2`,
      [personId, organizerId]
    );

    res.json({ success: true, deleted_email: personRes.rows[0].email });
  } catch (err) {
    console.error('DELETE /api/persons/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
