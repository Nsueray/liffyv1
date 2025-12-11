const express = require('express');
const db = require('../db');
const jwt = require('jsonwebtoken');

const router = express.Router();

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

function mapResultRow(row) {
  const raw = row.raw || {};

  return {
    id: row.id,
    job_id: row.job_id,
    source_url: row.source_url,
    company_name: row.company_name || raw.companyName || null,
    contact_name: row.contact_name || raw.contactName || null,
    job_title: row.job_title || raw.jobTitle || null,
    emails: row.emails || raw.emails || [],
    website: row.website || raw.website || row.source_url || null,
    phone: row.phone || raw.phone || null,
    country: row.country || raw.country || null,
    city: row.city || raw.city || null,
    confidence_score: row.confidence_score || raw.confidence_score || null,
    verification_status: row.verification_status || raw.verification_status || null,
    status: row.status || raw.status || null,
    raw: row.raw || null
  };
}

/**
 * POST /api/mining/jobs/:id/results
 * Body:
 * {
 *   results: [
 *     {
 *       url,
 *       companyName,
 *       contactName,
 *       jobTitle,
 *       phone,
 *       country,
 *       website,
 *       emails: [...]
 *       // diğer alanlar raw içine atılabilir
 *     },
 *     ...
 *   ],
 *   summary: {
 *     total_exhibitors,
 *     total_results,
 *     total_emails,
 *     exhibitors_with_emails,
 *     websites_found,
 *     contacts_found,
 *     time_minutes
 *   }
 * }
 */
router.post('/api/mining/jobs/:id/results', authRequired, async (req, res) => {
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

    // 1) Get job to ensure it exists and get organizer_id
    const jobRes = await client.query(
      'SELECT id, organizer_id FROM public.mining_jobs WHERE id = $1 AND organizer_id = $2',
      [jobId, req.auth.organizer_id]
    );

    if (jobRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Mining job not found',
      });
    }

    const job = jobRes.rows[0];
    const organizerId = job.organizer_id;

    // 2) Insert results into mining_results
    let totalEmails = 0;

    for (const r of results) {
      const emails = Array.isArray(r.emails)
        ? r.emails.filter((e) => typeof e === 'string')
        : [];

      totalEmails += emails.length;

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
          website,
          emails,
          raw
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
        )
        `,
        [
          jobId,
          organizerId,
          r.url || '',
          r.companyName || null,
          r.contactName || null,
          r.jobTitle || null,
          r.phone || null,
          r.country || null,
          r.website || null,
          emails,
          r, // raw: full meta object
        ]
      );
    }

    const totalFound = results.length;
    const statsPayload = {
      ...(summary || {}),
      total_found: totalFound,
      total_emails_raw: totalEmails,
      saved_at: new Date().toISOString(),
    };

    // 3) Update mining_jobs aggregate fields
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
router.get('/api/mining/jobs/:id/results', authRequired, async (req, res) => {
  try {
    const jobId = req.params.id;
    const organizerId = req.auth.organizer_id;

    const jobRes = await db.query(
      `SELECT id FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
      [jobId, organizerId]
    );

    if (jobRes.rowCount === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    const resultsRes = await db.query(
      `SELECT * FROM mining_results WHERE job_id = $1 AND organizer_id = $2 ORDER BY created_at DESC`,
      [jobId, organizerId]
    );

    return res.json({
      results: resultsRes.rows.map(mapResultRow),
      total: resultsRes.rowCount
    });
  } catch (err) {
    console.error("GET /mining/jobs/:id/results error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/mining/results/:id
 */
router.patch('/api/mining/results/:id', authRequired, async (req, res) => {
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
      'phone',
      'country',
      'city',
      'website',
      'emails',
      'status',
      'verification_status',
      'confidence_score',
      'raw'
    ];

    const sets = [];
    const values = [];
    let idx = 1;

    allowedFields.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        sets.push(`${field} = $${idx}`);
        values.push(req.body[field]);
        idx++;
      }
    });

    if (sets.length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    values.push(resultId, organizerId);

    const updateRes = await db.query(
      `UPDATE mining_results
       SET ${sets.join(', ')}
       WHERE id = $${idx} AND organizer_id = $${idx + 1}
       RETURNING *`,
      values
    );

    return res.json({ result: mapResultRow(updateRes.rows[0]) });
  } catch (err) {
    console.error("PATCH /mining/results/:id error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/mining/results/:id
 */
router.delete('/api/mining/results/:id', authRequired, async (req, res) => {
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
      `DELETE FROM mining_results WHERE id = $1 AND organizer_id = $2`,
      [resultId, organizerId]
    );

    return res.json({ deleted: true });
  } catch (err) {
    console.error("DELETE /mining/results/:id error:", err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
