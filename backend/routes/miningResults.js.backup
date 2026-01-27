const express = require('express');
const db = require('../db');
const jwt = require('jsonwebtoken');
const { validateJobId, validateResultId } = require('../utils/validation');
const { UnifiedContact } = require('../services/superMiner/types/UnifiedContact');
const { validateContacts } = require('../services/validators/resultValidator');
const { deduplicate } = require('../services/validators/deduplicator');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";
const MANUAL_MINER_TOKEN = process.env.MANUAL_MINER_TOKEN;

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
    req.user = req.auth;
    next();
  } catch (err) {
    console.error("Auth error:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function authRequiredOrManual(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (MANUAL_MINER_TOKEN && authHeader) {
    const token = authHeader.replace("Bearer ", "").trim();
    if (token === MANUAL_MINER_TOKEN) {
      req.is_manual_miner = true;
      return next();
    }
  }

  return authRequired(req, res, next);
}

function mapResultRow(row) {
  const raw = row.raw || {};
  const toIsoOrNull = (value) => {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };
  const rawEmails = raw.emails || [];
  const parsedEmails = Array.isArray(row.emails)
    ? row.emails
    : Array.isArray(rawEmails)
      ? rawEmails
      : typeof row.emails === 'string'
        ? [row.emails]
        : [];

  const confidence = row.confidence_score ?? raw.confidence_score ?? raw.confidenceScore;
  let parsedConfidence = null;

  if (confidence !== null && confidence !== undefined) {
    const num = Number(confidence);
    parsedConfidence = Number.isFinite(num) ? Math.min(Math.max(num, 0), 100) : null;
  }

  return {
    id: row.id,
    job_id: row.job_id,
    company_name: row.company_name ?? raw.companyName ?? null,
    contact_name: row.contact_name ?? raw.contactName ?? null,
    job_title: row.job_title ?? raw.jobTitle ?? null,
    emails: parsedEmails.filter((email) => typeof email === 'string'),
    website: row.website ?? raw.website ?? raw.sourceUrl ?? row.source_url ?? null,
    phone: row.phone ?? raw.phone ?? null,
    country: row.country ?? raw.country ?? null,
    city: row.city ?? raw.city ?? null,
    address: row.address ?? raw.address ?? null,
    source_url: row.source_url ?? raw.sourceUrl ?? null,
    confidence_score: parsedConfidence,
    verification_status: row.verification_status || raw.verification_status || raw.verificationStatus || 'unverified',
    status: row.status || raw.status || 'new',
    created_at: toIsoOrNull(row.created_at || raw.created_at),
    updated_at: toIsoOrNull(row.updated_at || raw.updated_at)
  };
}

/**
 * POST /api/mining/jobs/:id/results
 */
router.post('/api/mining/jobs/:id/results', authRequiredOrManual, validateJobId, async (req, res) => {
  const jobId = req.params.id;
  const { results, summary } = req.body || {};

  if (!Array.isArray(results) || results.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'results must be a non-empty array',
    });
  }

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    let jobRes;
    if (req.is_manual_miner) {
      jobRes = await client.query(
        'SELECT id, organizer_id FROM public.mining_jobs WHERE id = $1',
        [jobId]
      );
    } else {
      jobRes = await client.query(
        'SELECT id, organizer_id FROM public.mining_jobs WHERE id = $1 AND organizer_id = $2',
        [jobId, req.auth.organizer_id]
      );
    }

    if (jobRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Mining job not found',
      });
    }

    const job = jobRes.rows[0];
    const organizerId = job.organizer_id;

    // ===== CENTRAL EDIT PIPELINE =====

    // Step 1: Convert raw miner results to plain objects for validator
    const plainContacts = results.map(r => ({
      email: r.email || (r.emails && r.emails[0]),
      name: r.contactName || r.contact_name || r.name,
      company: r.companyName || r.company_name || r.company,
      phone: r.phone,
      website: r.website,
      country: r.country,
      city: r.city,
      title: r.jobTitle || r.job_title || r.title,
      address: r.address,
      _raw: r
    }));

    // Step 2: Validate contacts (plain objects)
    const validationResult = validateContacts(plainContacts);

    // Step 3: Prepare plain objects for deduplicator (no _raw, no _unified)
    const contactsForDedup = validationResult.valid.map(v => ({
      email: v.email,
      name: v.name,
      company: v.company,
      phone: v.phone,
      website: v.website,
      country: v.country,
      city: v.city,
      title: v.title,
      address: v.address,
      _raw: v._raw
    }));

    // Step 4: Deduplicate (plain objects)
    const dedupeResult = deduplicate(contactsForDedup);

    // Step 5: Convert final plain objects to UnifiedContact (ONCE)
    const finalContacts = dedupeResult.contacts.map(c => {
      const raw = c._raw || {};
      const source = raw.source || (req.is_manual_miner ? 'manual' : 'import');
      
      return UnifiedContact.fromLegacy({
        email: c.email,
        contactName: c.name,
        companyName: c.company,
        phone: c.phone,
        website: c.website,
        country: c.country,
        city: c.city,
        jobTitle: c.title,
        address: c.address,
        emails: raw.emails,
        sourceUrl: raw.sourceUrl || raw.source_url || raw.url,
        confidence: raw.confidence || raw.confidence_score,
        evidence: raw.evidence,
        raw: raw
      }, source);
    });

    // Step 6: Convert to DB format and insert
    let totalEmails = 0;

    for (const uc of finalContacts) {
      const dbRow = uc.toDBFormat(jobId, organizerId);
      totalEmails += dbRow.emails.length;

      await client.query(
        `
        INSERT INTO public.mining_results (
          job_id,
          organizer_id,
          source_url,
          company_name,
          contact_name,
          job_title,
          phone,
          country,
          city,
          address,
          website,
          emails,
          confidence_score,
          raw
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
        )
        `,
        [
          dbRow.job_id,
          dbRow.organizer_id,
          dbRow.source_url || '',
          dbRow.company_name,
          dbRow.contact_name,
          dbRow.job_title,
          dbRow.phone,
          dbRow.country,
          dbRow.city,
          dbRow.address,
          dbRow.website,
          dbRow.emails,
          dbRow.confidence_score,
          dbRow.raw
        ]
      );
    }

    // ===== END CENTRAL EDIT PIPELINE =====

    const totalFound = finalContacts.length;
    const statsPayload = {
      ...(summary || {}),
      total_found: totalFound,
      total_emails_raw: totalEmails,
      saved_at: new Date().toISOString(),
    };

    const updateRes = await client.query(
      `
      UPDATE public.mining_jobs
      SET
        total_found = COALESCE(total_found, 0) + $1,
        total_emails_raw = COALESCE(total_emails_raw, 0) + $2,
        stats = COALESCE(stats, '{}'::jsonb) || $3::jsonb,
        status = 'completed',
        completed_at = NOW()
      WHERE id = $4
      RETURNING *
      `,
      [totalFound, totalEmails, statsPayload, jobId]
    );

    await client.query('COMMIT');

    return res.json({
      success: true,
      inserted: totalFound,
      total_emails: totalEmails,
      job: updateRes.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error saving mining results:', err);
    return res.status(500).json({
      success: false,
      message: 'Error saving mining results',
      error: err.message,
    });
  } finally {
    client.release();
  }
});

/**
 * GET /api/mining/jobs/:id/results
 */
router.get('/api/mining/jobs/:id/results', authRequired, validateJobId, async (req, res) => {
  try {
    const jobId = req.params.id;
    const organizerId = req.auth.organizer_id;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const offset = (page - 1) * limit;
    const { has_email, status, verification_status, country, search } = req.query;

    const jobRes = await db.query(
      `SELECT id FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
      [jobId, organizerId]
    );

    if (jobRes.rowCount === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    const where = ['mj.organizer_id = $1', 'mr.job_id = $2'];
    const params = [organizerId, jobId];
    let idx = 3;
    const emailLengthExpr = `CASE 
      WHEN jsonb_typeof(COALESCE(mr.emails::jsonb, '[]'::jsonb)) = 'array'
      THEN jsonb_array_length(COALESCE(mr.emails::jsonb, '[]'::jsonb))
      ELSE 0
    END`;

    if (has_email === 'with') {
      where.push(`${emailLengthExpr} > 0`);
    } else if (has_email === 'without') {
      where.push(`${emailLengthExpr} = 0`);
    }

    if (status && status !== 'all') {
      where.push(`COALESCE(mr.status, 'new') = $${idx}`);
      params.push(status);
      idx++;
    }

    if (verification_status && verification_status !== 'all') {
      where.push(`COALESCE(mr.verification_status, 'unverified') = $${idx}`);
      params.push(verification_status);
      idx++;
    }

    if (country) {
      where.push(`mr.country ILIKE $${idx}`);
      params.push(`%${country}%`);
      idx++;
    }

    if (search) {
      where.push(`(
        COALESCE(mr.company_name, '') ILIKE $${idx} OR
        COALESCE(mr.contact_name, '') ILIKE $${idx} OR
        COALESCE(mr.website, '') ILIKE $${idx} OR
        COALESCE(mr.source_url, '') ILIKE $${idx} OR
        COALESCE((mr.emails)::jsonb::text, '') ILIKE $${idx}
      )`);
      params.push(`%${search}%`);
      idx++;
    }

    const whereSql = where.join(' AND ');

    const resultsRes = await db.query(
      `SELECT 
        mr.id,
        mr.job_id,
        mr.company_name,
        mr.contact_name,
        mr.job_title,
        mr.emails,
        mr.website,
        mr.phone,
        mr.country,
        mr.city,
        mr.address,
        mr.source_url,
        mr.confidence_score,
        mr.verification_status,
        mr.status,
        mr.created_at,
        mr.updated_at,
        mr.raw
      FROM mining_results mr
      JOIN mining_jobs mj ON mj.id = mr.job_id
      WHERE ${whereSql}
      ORDER BY mr.created_at DESC, mr.id DESC
      LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    );

    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total
      FROM mining_results mr
      JOIN mining_jobs mj ON mj.id = mr.job_id
      WHERE ${whereSql}`,
      params
    );

    const total = countRes.rows[0]?.total || 0;

    return res.json({
      results: resultsRes.rows.map(mapResultRow),
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error("GET /mining/jobs/:id/results error:", err);
    return res.status(500).json({ error: "Failed to fetch results" });
  }
});

/**
 * PATCH /api/mining/results/:id
 */
router.patch('/api/mining/results/:id', authRequired, validateResultId, async (req, res) => {
  try {
    const resultId = req.params.id;
    const organizerId = req.auth.organizer_id;

    const existingRes = await db.query(
      `SELECT mr.*
      FROM mining_results mr
      JOIN mining_jobs mj ON mj.id = mr.job_id
      WHERE mr.id = $1 AND mj.organizer_id = $2`,
      [resultId, organizerId]
    );

    if (existingRes.rowCount === 0) {
      return res.status(404).json({ error: "Result not found" });
    }

    const allowedFields = [
      'company_name',
      'contact_name',
      'job_title',
      'emails',
      'website',
      'phone',
      'country',
      'city',
      'address',
      'source_url',
      'confidence_score',
      'verification_status',
      'status'
    ];

    const sets = [];
    const values = [];
    let idx = 1;

    allowedFields.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        let value = req.body[field];
        if (field === 'emails') {
          const emails = Array.isArray(value) ? value.filter((e) => typeof e === 'string') : [];
          value = emails;
        }
        if (field === 'confidence_score') {
          const numVal = Number(value);
          value = Number.isFinite(numVal) ? numVal : null;
        }
        sets.push(`${field} = $${idx}`);
        values.push(value);
        idx++;
      }
    });

    if (sets.length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    sets.push(`updated_at = NOW()`);

    values.push(resultId, organizerId);

    const updateRes = await db.query(
      `UPDATE mining_results mr
      SET ${sets.join(', ')}
      FROM mining_jobs mj
      WHERE mr.job_id = mj.id
        AND mr.id = $${idx}
        AND mj.organizer_id = $${idx + 1}
      RETURNING mr.*`,
      values
    );

    if (updateRes.rowCount === 0) {
      return res.status(404).json({ error: "Result not found" });
    }

    return res.json({ result: mapResultRow(updateRes.rows[0]) });
  } catch (err) {
    console.error("PATCH /mining/results/:id error:", err);
    return res.status(500).json({ error: "Failed to update result" });
  }
});

/**
 * DELETE /api/mining/results/:id
 */
router.delete('/api/mining/results/:id', authRequired, validateResultId, async (req, res) => {
  try {
    const resultId = req.params.id;
    const organizerId = req.auth.organizer_id;

    const existingRes = await db.query(
      `SELECT mr.id
      FROM mining_results mr
      JOIN mining_jobs mj ON mj.id = mr.job_id
      WHERE mr.id = $1 AND mj.organizer_id = $2`,
      [resultId, organizerId]
    );

    if (existingRes.rowCount === 0) {
      return res.status(404).json({ error: "Result not found" });
    }

    await db.query(
      `DELETE FROM mining_results mr
      USING mining_jobs mj
      WHERE mr.job_id = mj.id
        AND mr.id = $1
        AND mj.organizer_id = $2`,
      [resultId, organizerId]
    );

    return res.json({ message: "Result deleted successfully" });
  } catch (err) {
    console.error("DELETE /mining/results/:id error:", err);
    return res.status(500).json({ error: "Failed to delete result" });
  }
});

module.exports = router;
