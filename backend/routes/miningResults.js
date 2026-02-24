const express = require('express');
const db = require('../db');
const jwt = require('jsonwebtoken');
const { validateJobId, validateResultId } = require('../utils/validation');
const { UnifiedContact } = require('../services/superMiner/types/UnifiedContact');
const { validateContacts } = require('../services/validators/resultValidator');
const { deduplicate } = require('../services/validators/deduplicator');
const { normalizeMinerOutput } = require('../services/normalizer');
const aggregationTrigger = require('../services/aggregationTrigger');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";
const MANUAL_MINER_TOKEN = process.env.MANUAL_MINER_TOKEN;
const IMPORT_BATCH_SIZE = 200;

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

    // Canonical aggregation: persons + affiliations (best-effort, never breaks response)
    try {
      const emailContacts = finalContacts.filter(uc => uc.email);
      if (emailContacts.length > 0 && aggregationTrigger.isEnabled()) {
        const minerOutput = {
          status: 'success',
          raw: {
            text: '',
            html: '',
            blocks: emailContacts.map(uc => ({
              email: uc.email || null,
              emails: uc.email ? [uc.email] : [],
              company_name: uc.companyName || null,
              contact_name: uc.contactName || null,
              website: uc.website || null,
              country: uc.country || null,
              phone: uc.phone || null,
              text: null,
              data: uc,
            })),
            links: [],
          },
          meta: {
            miner_name: req.is_manual_miner ? 'local_miner' : 'external_push',
            duration_ms: 0,
            confidence_hint: null,
            source_url: results[0]?.sourceUrl || results[0]?.source_url || null,
            page_title: null,
          },
        };

        const normResult = normalizeMinerOutput(minerOutput);

        await aggregationTrigger.process({
          jobId,
          organizerId,
          normalizationResult: normResult,
          metadata: {
            original_contact_count: emailContacts.length,
            source: req.is_manual_miner ? 'local_miner' : 'external_push',
          },
        });

        console.log(`[POST results] Canonical aggregation: ${normResult.stats?.candidates_produced || 0} candidates processed`);
      }
    } catch (aggErr) {
      // Best-effort — never break the response
      console.error('[POST results] Canonical aggregation error (non-fatal):', aggErr.message);
    }

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
 * Process a single batch of mining results for import.
 * Called by the background processor within a transaction.
 */
async function processImportBatch(client, batchRows, organizerId, jobId, tagsArray, listId) {
  let imported = 0, skipped = 0, duplicates = 0;
  let personsUpserted = 0, affiliationsUpserted = 0;
  const errors = [];

  // ── Dedup within batch: keep first occurrence of each email ──
  const seenEmails = new Set();
  const dedupedRows = [];
  for (const mr of batchRows) {
    const emails = Array.isArray(mr.emails) ? mr.emails : [];
    const primaryEmail = emails.find(e => e && typeof e === 'string' && e.includes('@'));
    if (!primaryEmail) {
      skipped++;
      continue;
    }
    const key = primaryEmail.trim().toLowerCase();
    if (seenEmails.has(key)) {
      skipped++;
      // Still mark as imported so it's not re-fetched in next batch
      await client.query(
        `UPDATE mining_results SET status = 'imported', updated_at = NOW() WHERE id = $1`,
        [mr.id]
      );
      continue;
    }
    seenEmails.add(key);
    dedupedRows.push({ ...mr, _primaryEmail: key });
  }

  // ── Sort by email for consistent lock ordering ──
  dedupedRows.sort((a, b) => a._primaryEmail.localeCompare(b._primaryEmail));

  for (const mr of dedupedRows) {
    // ── SAVEPOINT per row: prevents single-row error from aborting entire transaction ──
    const savepointName = `sp_${mr.id.replace(/-/g, '')}`;
    await client.query(`SAVEPOINT ${savepointName}`);

    try {
      const trimmedEmail = mr._primaryEmail;

      // Legacy: prospects table check/upsert
      const existingProspect = await client.query(
        'SELECT id, tags FROM prospects WHERE organizer_id = $1 AND LOWER(email) = $2',
        [organizerId, trimmedEmail]
      );

      let prospectId;

      if (existingProspect.rows.length > 0) {
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
        const meta = {
          mining_result_id: mr.id,
          job_id: jobId,
          job_title: mr.job_title,
          all_emails: Array.isArray(mr.emails) ? mr.emails : [],
          website: mr.website,
          phone: mr.phone,
          city: mr.city,
          address: mr.address,
          source_url: mr.source_url,
          confidence_score: mr.confidence_score
        };

        const prospectRes = await client.query(
          `INSERT INTO prospects (
            organizer_id, email, name, company, country,
            source_type, source_ref, verification_status, tags, meta
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING id`,
          [
            organizerId, trimmedEmail,
            mr.contact_name || null, mr.company_name || null,
            mr.country || null, 'mining', jobId,
            mr.verification_status || 'unknown',
            tagsArray.length > 0 ? tagsArray : [], meta
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

      // Canonical: persons table UPSERT (Phase 3 dual-write)
      const nameParts = (mr.contact_name || '').trim().split(/\s+/);
      const firstName = nameParts[0] || null;
      const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : null;

      const personResult = await client.query(
        `INSERT INTO persons (organizer_id, email, first_name, last_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (organizer_id, LOWER(email)) DO UPDATE SET
           first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), persons.first_name),
           last_name = COALESCE(NULLIF(EXCLUDED.last_name, ''), persons.last_name),
           updated_at = NOW()
         RETURNING id`,
        [organizerId, trimmedEmail, firstName, lastName]
      );
      personsUpserted++;
      const personId = personResult.rows[0].id;

      // Canonical: affiliations table UPSERT (skip email addresses and pipe-separated junk)
      if (mr.company_name && !mr.company_name.includes('@') && !mr.company_name.includes('|')) {
        await client.query(
          `INSERT INTO affiliations (organizer_id, person_id, company_name, position, country_code, city, website, phone, source_type, source_ref)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'mining', $9)
           ON CONFLICT (organizer_id, person_id, LOWER(company_name))
           WHERE company_name IS NOT NULL
           DO UPDATE SET
             position = COALESCE(NULLIF(EXCLUDED.position, ''), affiliations.position),
             country_code = COALESCE(NULLIF(EXCLUDED.country_code, ''), affiliations.country_code),
             city = COALESCE(NULLIF(EXCLUDED.city, ''), affiliations.city),
             website = COALESCE(NULLIF(EXCLUDED.website, ''), affiliations.website),
             phone = COALESCE(NULLIF(EXCLUDED.phone, ''), affiliations.phone)`,
          [
            organizerId, personId, mr.company_name,
            mr.job_title || null,
            mr.country ? mr.country.substring(0, 2).toUpperCase() : null,
            mr.city || null, mr.website || null,
            mr.phone || null, jobId
          ]
        );
        affiliationsUpserted++;
      }

      // Mark mining result as imported
      await client.query(
        `UPDATE mining_results SET status = 'imported', updated_at = NOW() WHERE id = $1`,
        [mr.id]
      );

      // Release savepoint on success
      await client.query(`RELEASE SAVEPOINT ${savepointName}`);
      imported++;
    } catch (rowErr) {
      // Rollback to savepoint — transaction stays valid for remaining rows
      await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      console.error(`Error importing result ${mr.id}:`, rowErr.message);
      errors.push({ id: mr.id, error: rowErr.message });
      skipped++;
    }
  }

  return { imported, skipped, duplicates, personsUpserted, affiliationsUpserted, errors };
}

/**
 * Background processor for import-all.
 * Processes mining results in batches of IMPORT_BATCH_SIZE with per-batch transactions.
 * Each batch commits independently so partial imports survive crashes.
 */
async function processImportInBackground(jobId, organizerId, tagsArray, listId) {
  let totalImported = 0, totalSkipped = 0, totalDuplicates = 0;
  let totalPersonsUpserted = 0, totalAffiliationsUpserted = 0;
  const allErrors = [];

  try {
    // Get initial total for progress tracking
    const totalRes = await db.query(`
      SELECT COUNT(*)::int as total
      FROM mining_results mr
      WHERE mr.job_id = $1 AND mr.organizer_id = $2
        AND COALESCE(array_length(mr.emails, 1), 0) > 0
        AND COALESCE(mr.status, 'new') != 'imported'
    `, [jobId, organizerId]);
    const totalToProcess = totalRes.rows[0].total;

    while (true) {
      // Fetch next batch (status != 'imported' naturally skips already-processed rows)
      const batchRes = await db.query(`
        SELECT mr.id, mr.company_name, mr.contact_name, mr.job_title,
               mr.emails, mr.website, mr.phone, mr.country, mr.city,
               mr.address, mr.source_url, mr.confidence_score, mr.verification_status
        FROM mining_results mr
        WHERE mr.job_id = $1 AND mr.organizer_id = $2
          AND COALESCE(array_length(mr.emails, 1), 0) > 0
          AND COALESCE(mr.status, 'new') != 'imported'
        ORDER BY mr.id
        LIMIT $3
      `, [jobId, organizerId, IMPORT_BATCH_SIZE]);

      if (batchRes.rows.length === 0) break;

      // Process batch in its own transaction
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const result = await processImportBatch(client, batchRes.rows, organizerId, jobId, tagsArray, listId);
        await client.query('COMMIT');

        totalImported += result.imported;
        totalSkipped += result.skipped;
        totalDuplicates += result.duplicates;
        totalPersonsUpserted += result.personsUpserted;
        totalAffiliationsUpserted += result.affiliationsUpserted;
        if (result.errors.length > 0) allErrors.push(...result.errors);
      } catch (batchErr) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`Batch transaction error for job ${jobId}:`, batchErr.message);
        totalSkipped += batchRes.rows.length;
        allErrors.push({ batch_error: batchErr.message, affected_count: batchRes.rows.length });
      } finally {
        client.release();
      }

      // Update progress after each batch
      await db.query(
        `UPDATE mining_jobs SET import_progress = $2 WHERE id = $1`,
        [jobId, JSON.stringify({
          imported: totalImported,
          skipped: totalSkipped,
          duplicates: totalDuplicates,
          total: totalToProcess,
          persons_upserted: totalPersonsUpserted,
          affiliations_upserted: totalAffiliationsUpserted,
          errors: allErrors.slice(-10)
        })]
      );
    }

    // Build final progress
    const finalProgress = {
      imported: totalImported,
      skipped: totalSkipped,
      duplicates: totalDuplicates,
      new_prospects: totalImported - totalDuplicates,
      total: totalToProcess,
      persons_upserted: totalPersonsUpserted,
      affiliations_upserted: totalAffiliationsUpserted,
      errors: allErrors.slice(-10),
      completed_at: new Date().toISOString()
    };

    // If list was created, include member count
    if (listId) {
      const listCount = await db.query(
        'SELECT COUNT(*)::int as count FROM list_members WHERE list_id = $1',
        [listId]
      );
      finalProgress.list_member_count = listCount.rows[0].count;
    }

    // Mark as completed
    await db.query(
      `UPDATE mining_jobs SET import_status = 'completed', import_progress = $2 WHERE id = $1`,
      [jobId, JSON.stringify(finalProgress)]
    );

    console.log(`Import completed for job ${jobId}: ${totalImported} imported, ${totalSkipped} skipped`);
  } catch (err) {
    console.error(`Background import fatal error for job ${jobId}:`, err);
    try {
      await db.query(
        `UPDATE mining_jobs SET import_status = 'failed', import_progress = COALESCE(import_progress, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
        [jobId, JSON.stringify({
          error: err.message,
          failed_at: new Date().toISOString(),
          imported: totalImported,
          skipped: totalSkipped
        })]
      );
    } catch (updateErr) {
      console.error(`Failed to update import status for job ${jobId}:`, updateErr);
    }
  }
}


/**
 * ============================================================
 * POST /api/mining/jobs/:id/import-all
 * ============================================================
 * Import ALL mining results from a job to prospects (leads).
 * Uses background processing with batched transactions
 * to avoid Render's 30s request timeout on large datasets (3000+ records).
 *
 * Returns 202 Accepted immediately.
 * Frontend polls GET /api/mining/jobs/:id for import_status + import_progress.
 */
router.post('/api/mining/jobs/:id/import-all', authRequired, validateJobId, async (req, res) => {
  try {
    const jobId = req.params.id;
    const organizerId = req.auth.organizer_id;
    const {
      tags = [],
      create_list = false,
      list_name = null
    } = req.body;

    // Validate job exists and belongs to organizer
    const jobRes = await db.query(
      `SELECT id, name, input, total_found, import_status, import_progress FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
      [jobId, organizerId]
    );

    if (jobRes.rowCount === 0) {
      return res.status(404).json({ error: "Mining job not found" });
    }

    const job = jobRes.rows[0];

    // Prevent concurrent imports (with 5-minute staleness check for crash recovery)
    if (job.import_status === 'processing') {
      const progress = job.import_progress || {};
      const startedAt = progress.started_at ? new Date(progress.started_at) : null;
      const isStale = startedAt && (Date.now() - startedAt.getTime() > 5 * 60 * 1000);

      if (!isStale) {
        return res.status(409).json({
          error: "Import already in progress",
          import_status: job.import_status,
          import_progress: job.import_progress
        });
      }
      console.log(`Stale import detected for job ${jobId}, allowing restart`);
    }

    // Validate list name if creating list
    if (create_list && (!list_name || !list_name.trim())) {
      return res.status(400).json({ error: "List name is required when create_list is true" });
    }

    // Count importable results
    const countRes = await db.query(`
      SELECT COUNT(*)::int as total
      FROM mining_results mr
      WHERE mr.job_id = $1 AND mr.organizer_id = $2
        AND COALESCE(array_length(mr.emails, 1), 0) > 0
        AND COALESCE(mr.status, 'new') != 'imported'
    `, [jobId, organizerId]);

    const totalToImport = countRes.rows[0].total;

    if (totalToImport === 0) {
      return res.status(400).json({
        error: "No results to import",
        message: "No results with valid emails found, or all results are already imported"
      });
    }

    // Create list synchronously if requested (fast operation)
    let listId = null;
    let listCreated = null;

    if (create_list) {
      const trimmedListName = list_name.trim();

      const existingList = await db.query(
        'SELECT id FROM lists WHERE organizer_id = $1 AND LOWER(name) = LOWER($2)',
        [organizerId, trimmedListName]
      );

      if (existingList.rows.length > 0) {
        return res.status(409).json({ error: `A list named "${trimmedListName}" already exists` });
      }

      const listRes = await db.query(
        `INSERT INTO lists (organizer_id, name) VALUES ($1, $2) RETURNING id, name, created_at`,
        [organizerId, trimmedListName]
      );
      listId = listRes.rows[0].id;
      listCreated = listRes.rows[0];
    }

    // Process tags
    const tagsArray = Array.isArray(tags)
      ? tags.filter(t => t && typeof t === 'string' && t.trim()).map(t => t.trim())
      : [];

    // Mark job as importing
    await db.query(
      `UPDATE mining_jobs SET import_status = 'processing', import_progress = $2 WHERE id = $1`,
      [jobId, JSON.stringify({
        imported: 0, skipped: 0, duplicates: 0, total: totalToImport,
        persons_upserted: 0, affiliations_upserted: 0,
        started_at: new Date().toISOString()
      })]
    );

    // Return immediately (202 Accepted)
    const response = {
      status: "processing",
      job_id: jobId,
      total_to_import: totalToImport,
      tags_applied: tagsArray,
      message: `Import started for ${totalToImport} results. Poll GET /api/mining/jobs/${jobId} for progress.`
    };

    if (listCreated) {
      response.list_created = listCreated;
    }

    res.status(202).json(response);

    // Launch background processing (non-blocking)
    setImmediate(() => {
      processImportInBackground(jobId, organizerId, tagsArray, listId).catch(err => {
        console.error(`Background import failed for job ${jobId}:`, err);
      });
    });
  } catch (err) {
    console.error('POST /mining/jobs/:id/import-all error:', err);
    return res.status(500).json({
      error: "Failed to start import",
      message: err.message
    });
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
