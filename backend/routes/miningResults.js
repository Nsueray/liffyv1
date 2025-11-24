const express = require('express');
const db = require('../db');

const router = express.Router();

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
router.post('/api/mining/jobs/:id/results', async (req, res) => {
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
      'SELECT id, organizer_id FROM public.mining_jobs WHERE id = $1',
      [jobId]
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

module.exports = router;
