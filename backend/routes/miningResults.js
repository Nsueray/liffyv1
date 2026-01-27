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

    const validationResult = validateContacts(plainContacts);

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

    const dedupeResult = deduplicate(contactsForDedup);

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
    
    // emails is text[] array, use array_length
    if (has_email === 'with') {
      where.push(`COALESCE(array_length(mr.emails, 1), 0) > 0`);
    } else if (has_email === 'without') {
      where.push(`COALESCE(array_length(mr.emails, 1), 0) = 0`);
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
        COALESCE(array_to_string(mr.emails, ','), '') ILIKE $${idx}
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
 * ============================================================
 * POST /api/mining/jobs/:id/import-all
 * ============================================================
 * Import ALL mining results from a job to prospects (leads)
 * - Only imports results with valid emails
 * - Supports tags
 * - Optionally creates a list
 * - Single click = 600+ contacts imported!
 */
router.post('/api/mining/jobs/:id/import-all', authRequired, validateJobId, async (req, res) => {
  const client = await db.connect();
  
  try {
    const jobId = req.params.id;
    const organizerId = req.auth.organizer_id;
    const { 
      tags = [],
      create_list = false,
      list_name = null
    } = req.body;

    // Validate job exists and belongs to organizer
    const jobRes = await client.query(
      `SELECT id, name, input, total_found FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
      [jobId, organizerId]
    );

    if (jobRes.rowCount === 0) {
      return res.status(404).json({ error: "Mining job not found" });
    }

    const job = jobRes.rows[0];

    // Validate list name if creating list
    if (create_list && (!list_name || !list_name.trim())) {
      return res.status(400).json({ error: "List name is required when create_list is true" });
    }

    await client.query('BEGIN');

    // Get ALL mining results with valid emails (no pagination!)
    // emails is text[] array, use array_length
    const resultsRes = await client.query(`
      SELECT 
        mr.id,
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
        mr.status
      FROM mining_results mr
      WHERE mr.job_id = $1 
        AND mr.organizer_id = $2
        AND COALESCE(array_length(mr.emails, 1), 0) > 0
        AND COALESCE(mr.status, 'new') != 'imported'
    `, [jobId, organizerId]);

    const miningResults = resultsRes.rows;

    if (miningResults.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: "No results to import", 
        message: "No results with valid emails found, or all results are already imported"
      });
    }

    // Create list if requested
    let listId = null;
    let listCreated = null;

    if (create_list) {
      const trimmedListName = list_name.trim();
      
      // Check if list name already exists
      const existingList = await client.query(
        'SELECT id FROM lists WHERE organizer_id = $1 AND LOWER(name) = LOWER($2)',
        [organizerId, trimmedListName]
      );

      if (existingList.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `A list named "${trimmedListName}" already exists` });
      }

      const listRes = await client.query(
        `INSERT INTO lists (organizer_id, name, type) VALUES ($1, $2, 'mining_import') RETURNING id, name, created_at`,
        [organizerId, trimmedListName]
      );
      listId = listRes.rows[0].id;
      listCreated = listRes.rows[0];
    }

    // Process tags
    const tagsArray = Array.isArray(tags) 
      ? tags.filter(t => t && typeof t === 'string' && t.trim()).map(t => t.trim())
      : [];

    // Process each mining result
    let imported = 0;
    let skipped = 0;
    let duplicates = 0;
    const errors = [];

    for (const mr of miningResults) {
      try {
        // emails is already a text[] array from PostgreSQL
        const emails = Array.isArray(mr.emails) ? mr.emails : [];

        // Get first valid email
        const primaryEmail = emails.find(e => e && typeof e === 'string' && e.includes('@'));
        
        if (!primaryEmail) {
          skipped++;
          continue;
        }

        const trimmedEmail = primaryEmail.trim().toLowerCase();

        // Check if prospect already exists
        const existingProspect = await client.query(
          'SELECT id, tags FROM prospects WHERE organizer_id = $1 AND LOWER(email) = $2',
          [organizerId, trimmedEmail]
        );

        let prospectId;

        if (existingProspect.rows.length > 0) {
          // Prospect exists - update tags if new ones provided
          prospectId = existingProspect.rows[0].id;
          duplicates++;

          if (tagsArray.length > 0) {
            const existingTags = existingProspect.rows[0].tags || [];
            const mergedTags = [...new Set([...existingTags, ...tagsArray])];
            await client.query(
              'UPDATE prospects SET tags = $1 WHERE id = $2',
              [mergedTags, prospectId]
            );
          }
        } else {
          // Create new prospect
          const meta = {
            mining_result_id: mr.id,
            job_id: jobId,
            job_title: mr.job_title,
            all_emails: emails,
            website: mr.website,
            phone: mr.phone,
            city: mr.city,
            address: mr.address,
            source_url: mr.source_url,
            confidence_score: mr.confidence_score
          };

          const prospectRes = await client.query(
            `INSERT INTO prospects (
              organizer_id, 
              email, 
              name, 
              company, 
              country,
              source_type, 
              source_ref,
              verification_status,
              tags,
              meta
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id`,
            [
              organizerId,
              trimmedEmail,
              mr.contact_name || null,
              mr.company_name || null,
              mr.country || null,
              'mining',
              jobId,
              mr.verification_status || 'unknown',
              tagsArray.length > 0 ? tagsArray : [],
              meta
            ]
          );
          prospectId = prospectRes.rows[0].id;
        }

        // Add to list if creating one
        if (listId) {
          await client.query(
            `INSERT INTO list_members (list_id, prospect_id, organizer_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (list_id, prospect_id) DO NOTHING`,
            [listId, prospectId, organizerId]
          );
        }

        // Mark mining result as imported
        await client.query(
          `UPDATE mining_results SET status = 'imported', updated_at = NOW() WHERE id = $1`,
          [mr.id]
        );

        imported++;
      } catch (rowErr) {
        console.error(`Error importing result ${mr.id}:`, rowErr.message);
        errors.push({ id: mr.id, error: rowErr.message });
        skipped++;
      }
    }

    await client.query('COMMIT');

    // Build response
    const response = {
      success: true,
      stats: {
        total_with_email: miningResults.length,
        imported: imported,
        skipped: skipped,
        duplicates_updated: duplicates,
        new_prospects: imported - duplicates
      },
      tags_applied: tagsArray,
      message: `Successfully imported ${imported} leads from "${job.name || jobId}"`
    };

    if (listCreated) {
      response.list_created = listCreated;
      
      // Get final list member count
      const listCount = await db.query(
        'SELECT COUNT(*) as count FROM list_members WHERE list_id = $1',
        [listId]
      );
      response.list_created.member_count = parseInt(listCount.rows[0].count, 10);
    }

    if (errors.length > 0) {
      response.errors = errors.slice(0, 10);
    }

    return res.status(201).json(response);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /mining/jobs/:id/import-all error:', err);
    return res.status(500).json({ 
      error: "Failed to import results", 
      message: err.message 
    });
  } finally {
    client.release();
  }
});


/**
 * GET /api/mining/jobs/:id/import-preview
 * Preview how many results will be imported (with email, not yet imported)
 */
router.get('/api/mining/jobs/:id/import-preview', authRequired, validateJobId, async (req, res) => {
  try {
    const jobId = req.params.id;
    const organizerId = req.auth.organizer_id;

    // Verify job exists
    const jobRes = await db.query(
      `SELECT id, name, total_found FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
      [jobId, organizerId]
    );

    if (jobRes.rowCount === 0) {
      return res.status(404).json({ error: "Mining job not found" });
    }

    const job = jobRes.rows[0];

    // Count results - emails is text[] array, use array_length
    const countRes = await db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE COALESCE(array_length(mr.emails, 1), 0) > 0) as with_email,
        COUNT(*) FILTER (WHERE COALESCE(array_length(mr.emails, 1), 0) > 0 AND COALESCE(mr.status, 'new') != 'imported') as importable,
        COUNT(*) FILTER (WHERE COALESCE(mr.status, 'new') = 'imported') as already_imported,
        COUNT(*) as total
      FROM mining_results mr
      WHERE mr.job_id = $1 AND mr.organizer_id = $2
    `, [jobId, organizerId]);

    const stats = countRes.rows[0];

    return res.json({
      job_id: jobId,
      job_name: job.name,
      total_results: parseInt(stats.total, 10),
      with_email: parseInt(stats.with_email, 10),
      importable: parseInt(stats.importable, 10),
      already_imported: parseInt(stats.already_imported, 10),
      without_email: parseInt(stats.total, 10) - parseInt(stats.with_email, 10)
    });

  } catch (err) {
    console.error('GET /mining/jobs/:id/import-preview error:', err);
    return res.status(500).json({ error: "Failed to get preview" });
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
