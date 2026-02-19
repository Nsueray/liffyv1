const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const csvParser = require('csv-parser');
const { Readable } = require('stream');

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

// ============================================
// CSV UPLOAD (must be registered BEFORE /:id routes)
// ============================================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

// Header alias mapping for flexible CSV column matching
const HEADER_ALIASES = {
  email: ['email', 'e-mail', 'email_address', 'emailaddress', 'mail'],
  name: ['name', 'full_name', 'fullname', 'contact_name', 'contactname'],
  first_name: ['first_name', 'firstname', 'first', 'given_name'],
  last_name: ['last_name', 'lastname', 'last', 'surname', 'family_name'],
  company: ['company', 'organization', 'organisation', 'company_name', 'companyname', 'org'],
  country: ['country', 'country_code', 'countrycode', 'location'],
  position: ['position', 'title', 'job_title', 'jobtitle', 'role'],
  website: ['website', 'url', 'web', 'site'],
  phone: ['phone', 'telephone', 'tel', 'mobile', 'phone_number']
};

function normalizeHeader(header) {
  const clean = header.toLowerCase().trim().replace(/[^a-z0-9_]/g, '_');
  for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(clean)) return canonical;
  }
  return clean;
}

function normalizeRow(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    const canonicalKey = normalizeHeader(key);
    if (!normalized[canonicalKey] && value && value.trim()) {
      normalized[canonicalKey] = value.trim();
    }
  }
  // Build full name from first_name + last_name if name not present
  if (!normalized.name && (normalized.first_name || normalized.last_name)) {
    normalized.name = [normalized.first_name, normalized.last_name].filter(Boolean).join(' ');
  }
  return normalized;
}

function parseCSVBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const stream = Readable.from(buffer.toString('utf-8'));
    stream
      .pipe(csvParser())
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', (err) => reject(err));
  });
}

const CSV_BACKGROUND_THRESHOLD = 500;
const CSV_BATCH_SIZE = 200;

/**
 * Background processor for large CSV uploads.
 * Processes rows in batches with per-batch transactions.
 */
async function processCSVRowsInBackground(validRows, organizerId, listId, tags) {
  let imported = 0, skipped = 0;
  const errors = [];
  let personsUpserted = 0, affiliationsUpserted = 0;

  try {
    for (let batchStart = 0; batchStart < validRows.length; batchStart += CSV_BATCH_SIZE) {
      const batch = validRows.slice(batchStart, batchStart + CSV_BATCH_SIZE);
      const client = await db.connect();

      try {
        await client.query('BEGIN');

        for (let i = 0; i < batch.length; i++) {
          const row = batch[i];
          try {
            const email = row.email.toLowerCase().trim();

            // Legacy: prospects table
            let prospectId;
            const existingProspect = await client.query(
              `SELECT id FROM prospects WHERE organizer_id = $1 AND LOWER(email) = $2`,
              [organizerId, email]
            );

            if (existingProspect.rows.length > 0) {
              prospectId = existingProspect.rows[0].id;
              await client.query(
                `UPDATE prospects SET
                   name = COALESCE(NULLIF($3, ''), name),
                   company = COALESCE(NULLIF($4, ''), company),
                   country = COALESCE(NULLIF($5, ''), country),
                   sector = COALESCE(NULLIF($6, ''), sector)
                 WHERE id = $2 AND organizer_id = $1`,
                [organizerId, prospectId, row.name || '', row.company || '', row.country || '', row.position || '']
              );
            } else {
              const insertResult = await client.query(
                `INSERT INTO prospects (organizer_id, email, name, company, country, sector, source_type, source_ref, tags)
                 VALUES ($1, $2, $3, $4, $5, $6, 'import', 'CSV upload', $7)
                 RETURNING id`,
                [organizerId, email, row.name || null, row.company || null, row.country || null, row.position || null, tags || null]
              );
              prospectId = insertResult.rows[0].id;
            }

            // Legacy: list_members
            if (prospectId) {
              await client.query(
                `INSERT INTO list_members (list_id, prospect_id, organizer_id)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (list_id, prospect_id) DO NOTHING`,
                [listId, prospectId, organizerId]
              );
            }

            // Canonical: persons table UPSERT
            const firstName = row.first_name || (row.name ? row.name.split(/\s+/)[0] : null);
            const lastName = row.last_name || (row.name && row.name.includes(' ') ? row.name.split(/\s+/).slice(1).join(' ') : null);

            const personResult = await client.query(
              `INSERT INTO persons (organizer_id, email, first_name, last_name)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (organizer_id, LOWER(email)) DO UPDATE SET
                 first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), persons.first_name),
                 last_name = COALESCE(NULLIF(EXCLUDED.last_name, ''), persons.last_name),
                 updated_at = NOW()
               RETURNING id`,
              [organizerId, email, firstName || null, lastName || null]
            );
            personsUpserted++;
            const personId = personResult.rows[0].id;

            // Canonical: affiliations table UPSERT
            if (row.company) {
              await client.query(
                `INSERT INTO affiliations (organizer_id, person_id, company_name, position, country_code, website, phone, source_type, source_ref)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'import', 'CSV upload')
                 ON CONFLICT (organizer_id, person_id, LOWER(company_name))
                 WHERE company_name IS NOT NULL
                 DO UPDATE SET
                   position = COALESCE(NULLIF(EXCLUDED.position, ''), affiliations.position),
                   country_code = COALESCE(NULLIF(EXCLUDED.country_code, ''), affiliations.country_code),
                   website = COALESCE(NULLIF(EXCLUDED.website, ''), affiliations.website),
                   phone = COALESCE(NULLIF(EXCLUDED.phone, ''), affiliations.phone)`,
                [
                  organizerId,
                  personId,
                  row.company,
                  row.position || null,
                  row.country ? row.country.substring(0, 2).toUpperCase() : null,
                  row.website || null,
                  row.phone || null
                ]
              );
              affiliationsUpserted++;
            }

            imported++;
          } catch (rowErr) {
            errors.push({ row: batchStart + i + 1, email: row.email, error: rowErr.message });
            skipped++;
          }
        }

        await client.query('COMMIT');
      } catch (batchErr) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`CSV batch error for list ${listId}:`, batchErr.message);
        skipped += batch.length;
        errors.push({ batch_error: batchErr.message, from_row: batchStart + 1, to_row: batchStart + batch.length });
      } finally {
        client.release();
      }

      // Update progress after each batch
      await db.query(
        `UPDATE lists SET import_progress = $2 WHERE id = $1`,
        [listId, JSON.stringify({
          imported, skipped, total: validRows.length,
          persons_upserted: personsUpserted,
          affiliations_upserted: affiliationsUpserted,
          errors: errors.slice(-10)
        })]
      );
    }

    // Mark completed
    await db.query(
      `UPDATE lists SET import_status = 'completed', import_progress = $2 WHERE id = $1`,
      [listId, JSON.stringify({
        imported, skipped, total: validRows.length,
        persons_upserted: personsUpserted,
        affiliations_upserted: affiliationsUpserted,
        errors: errors.slice(-10),
        completed_at: new Date().toISOString()
      })]
    );

    // Auto-queue verification (best-effort)
    try {
      const orgCheck = await db.query(
        `SELECT zerobounce_api_key FROM organizers WHERE id = $1`,
        [organizerId]
      );
      if (orgCheck.rows.length > 0 && orgCheck.rows[0].zerobounce_api_key) {
        const { queueEmails } = require('../services/verificationService');
        const emailsToVerify = validRows.map(r => r.email.toLowerCase().trim());
        await queueEmails(organizerId, emailsToVerify, 'csv_upload');
      }
    } catch (vErr) {
      console.error('CSV background auto-queue verification error (non-fatal):', vErr.message);
    }

    console.log(`CSV import completed for list ${listId}: ${imported} imported, ${skipped} skipped`);
  } catch (err) {
    console.error(`Background CSV import fatal error for list ${listId}:`, err);
    try {
      await db.query(
        `UPDATE lists SET import_status = 'failed', import_progress = COALESCE(import_progress, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
        [listId, JSON.stringify({ error: err.message, failed_at: new Date().toISOString(), imported, skipped })]
      );
    } catch (updateErr) {
      console.error(`Failed to update list import status for ${listId}:`, updateErr);
    }
  }
}

// POST /api/lists/upload-csv
router.post('/upload-csv', authRequired, upload.single('file'), async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;

    if (!req.file) {
      return res.status(400).json({ error: 'CSV file is required' });
    }

    // Parse CSV
    const rawRows = await parseCSVBuffer(req.file.buffer);

    if (rawRows.length === 0) {
      return res.status(400).json({ error: 'CSV file is empty' });
    }

    if (rawRows.length > 10000) {
      return res.status(400).json({ error: 'Maximum 10,000 rows per upload' });
    }

    // Normalize rows
    const rows = rawRows.map(normalizeRow);

    // Validate: at least one row must have an email
    const validRows = rows.filter(r => r.email && r.email.includes('@'));
    if (validRows.length === 0) {
      return res.status(400).json({ error: 'No valid email addresses found in CSV. Ensure an "email" column exists.' });
    }

    // Create list
    const listName = (req.body.name && req.body.name.trim()) || req.file.originalname.replace(/\.csv$/i, '');
    let tags = null;
    if (req.body.tags) {
      try {
        tags = JSON.parse(req.body.tags);
        if (!Array.isArray(tags)) tags = null;
      } catch (e) {
        tags = null;
      }
    }

    const invalidEmailCount = rows.length - validRows.length;

    // Create list (fast, single query — outside transaction so it persists for background path)
    const listResult = await db.query(
      `INSERT INTO lists (organizer_id, name, type) VALUES ($1, $2, 'import') RETURNING id, name, created_at`,
      [organizerId, listName]
    );
    const newList = listResult.rows[0];

    // --- LARGE FILE: background processing ---
    if (validRows.length >= CSV_BACKGROUND_THRESHOLD) {
      await db.query(
        `UPDATE lists SET import_status = 'processing', import_progress = $2 WHERE id = $1`,
        [newList.id, JSON.stringify({
          imported: 0, skipped: invalidEmailCount, total: validRows.length,
          persons_upserted: 0, affiliations_upserted: 0,
          started_at: new Date().toISOString()
        })]
      );

      res.status(202).json({
        status: "processing",
        list_id: newList.id,
        list_name: newList.name,
        total_rows: rows.length,
        valid_rows: validRows.length,
        invalid_rows: invalidEmailCount,
        message: `CSV import started for ${validRows.length} rows. Poll GET /api/lists/${newList.id} for progress.`
      });

      setImmediate(() => {
        processCSVRowsInBackground(validRows, organizerId, newList.id, tags).catch(err => {
          console.error(`Background CSV import failed for list ${newList.id}:`, err);
        });
      });
      return;
    }

    // --- SMALL FILE: inline processing (single transaction) ---
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      let imported = 0;
      let skipped = 0;
      const errors = [];
      let personsUpserted = 0;
      let affiliationsUpserted = 0;

      for (let i = 0; i < validRows.length; i++) {
        const row = validRows[i];
        try {
          const email = row.email.toLowerCase().trim();

          // Legacy: prospects table
          let prospectId;
          const existingProspect = await client.query(
            `SELECT id FROM prospects WHERE organizer_id = $1 AND LOWER(email) = $2`,
            [organizerId, email]
          );

          if (existingProspect.rows.length > 0) {
            prospectId = existingProspect.rows[0].id;
            await client.query(
              `UPDATE prospects SET
                 name = COALESCE(NULLIF($3, ''), name),
                 company = COALESCE(NULLIF($4, ''), company),
                 country = COALESCE(NULLIF($5, ''), country),
                 sector = COALESCE(NULLIF($6, ''), sector)
               WHERE id = $2 AND organizer_id = $1`,
              [organizerId, prospectId, row.name || '', row.company || '', row.country || '', row.position || '']
            );
          } else {
            const insertResult = await client.query(
              `INSERT INTO prospects (organizer_id, email, name, company, country, sector, source_type, source_ref, tags)
               VALUES ($1, $2, $3, $4, $5, $6, 'import', 'CSV upload', $7)
               RETURNING id`,
              [organizerId, email, row.name || null, row.company || null, row.country || null, row.position || null, tags || null]
            );
            prospectId = insertResult.rows[0].id;
          }

          // Legacy: list_members
          if (prospectId) {
            await client.query(
              `INSERT INTO list_members (list_id, prospect_id, organizer_id)
               VALUES ($1, $2, $3)
               ON CONFLICT (list_id, prospect_id) DO NOTHING`,
              [newList.id, prospectId, organizerId]
            );
          }

          // Canonical: persons table UPSERT
          const firstName = row.first_name || (row.name ? row.name.split(/\s+/)[0] : null);
          const lastName = row.last_name || (row.name && row.name.includes(' ') ? row.name.split(/\s+/).slice(1).join(' ') : null);

          const personResult = await client.query(
            `INSERT INTO persons (organizer_id, email, first_name, last_name)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (organizer_id, LOWER(email)) DO UPDATE SET
               first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), persons.first_name),
               last_name = COALESCE(NULLIF(EXCLUDED.last_name, ''), persons.last_name),
               updated_at = NOW()
             RETURNING id`,
            [organizerId, email, firstName || null, lastName || null]
          );
          personsUpserted++;
          const personId = personResult.rows[0].id;

          // Canonical: affiliations table UPSERT
          if (row.company) {
            await client.query(
              `INSERT INTO affiliations (organizer_id, person_id, company_name, position, country_code, website, phone, source_type, source_ref)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'import', 'CSV upload')
               ON CONFLICT (organizer_id, person_id, LOWER(company_name))
               WHERE company_name IS NOT NULL
               DO UPDATE SET
                 position = COALESCE(NULLIF(EXCLUDED.position, ''), affiliations.position),
                 country_code = COALESCE(NULLIF(EXCLUDED.country_code, ''), affiliations.country_code),
                 website = COALESCE(NULLIF(EXCLUDED.website, ''), affiliations.website),
                 phone = COALESCE(NULLIF(EXCLUDED.phone, ''), affiliations.phone)`,
              [
                organizerId,
                personId,
                row.company,
                row.position || null,
                row.country ? row.country.substring(0, 2).toUpperCase() : null,
                row.website || null,
                row.phone || null
              ]
            );
            affiliationsUpserted++;
          }

          imported++;
        } catch (rowErr) {
          errors.push({ row: i + 1, email: row.email, error: rowErr.message });
          skipped++;
        }
      }

      skipped += invalidEmailCount;

      await client.query('COMMIT');

      // Auto-queue verification (best-effort, non-blocking)
      let verificationQueued = 0;
      try {
        const orgCheck = await db.query(
          `SELECT zerobounce_api_key FROM organizers WHERE id = $1`,
          [organizerId]
        );
        if (orgCheck.rows.length > 0 && orgCheck.rows[0].zerobounce_api_key) {
          const { queueEmails } = require('../services/verificationService');
          const emailsToVerify = validRows.map(r => r.email.toLowerCase().trim());
          const queueResult = await queueEmails(organizerId, emailsToVerify, 'csv_upload');
          verificationQueued = queueResult.queued;
        }
      } catch (vErr) {
        console.error('CSV upload auto-queue verification error (non-fatal):', vErr.message);
      }

      res.status(201).json({
        list_id: newList.id,
        list_name: newList.name,
        total_rows: rows.length,
        imported,
        skipped,
        errors: errors.slice(0, 20),
        canonical_sync: {
          persons_upserted: personsUpserted,
          affiliations_upserted: affiliationsUpserted
        },
        verification_queued: verificationQueued
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('POST /api/lists/upload-csv error:', err);

    if (err.message === 'Only CSV files are allowed') {
      return res.status(400).json({ error: err.message });
    }

    res.status(500).json({ error: err.message || 'Failed to upload CSV' });
  }
});

// GET /api/lists - Get all lists with counts
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

    // Get jobs from mining_jobs table
    // NOTE: Using 'input' column instead of 'target_url' (which doesn't exist)
    const result = await db.query(
      `
      SELECT 
        id,
        name,
        input,
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
        // Build a display name: use name if available, otherwise extract from input
        let displayName = row.name;
        
        if (!displayName && row.input) {
          // Try to parse as URL
          try {
            const url = new URL(row.input);
            displayName = url.hostname.replace('www.', '');
          } catch {
            // Not a URL, use first 50 chars of input
            displayName = row.input.substring(0, 50);
          }
        }
        
        if (!displayName) {
          displayName = `Job ${row.id.substring(0, 8)}`;
        }

        return {
          id: row.id,
          name: displayName,
          input: row.input || null,
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
      'SELECT id, name, created_at, import_status, import_progress FROM lists WHERE id = $1 AND organizer_id = $2',
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

    const response = {
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
    };

    if (list.import_status) {
      response.import_status = list.import_status;
      response.import_progress = list.import_progress;
    }

    res.json(response);
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

// ============================================
// MANUAL & IMPORT ENDPOINTS (Added for direct list creation)
// ============================================

// POST /api/lists/:id/add-manual - Add single prospect manually
router.post('/:id/add-manual', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const listId = req.params.id;
    const { email, name, company, country } = req.body;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    // Check list exists and belongs to organizer
    const listCheck = await db.query(
      'SELECT id FROM lists WHERE id = $1 AND organizer_id = $2',
      [listId, organizerId]
    );

    if (listCheck.rows.length === 0) {
      return res.status(404).json({ error: 'List not found' });
    }

    const trimmedEmail = email.trim().toLowerCase();

    // Check if prospect already exists
    let prospectId;
    const existingProspect = await db.query(
      'SELECT id FROM prospects WHERE organizer_id = $1 AND LOWER(email) = $2',
      [organizerId, trimmedEmail]
    );

    if (existingProspect.rows.length > 0) {
      prospectId = existingProspect.rows[0].id;
    } else {
      // Create new prospect
      const prospectResult = await db.query(
        `INSERT INTO prospects (organizer_id, email, name, company, country, source_type, source_ref)
         VALUES ($1, $2, $3, $4, $5, 'manual', 'Manual entry')
         RETURNING id`,
        [organizerId, trimmedEmail, name?.trim() || null, company?.trim() || null, country?.trim() || null]
      );
      prospectId = prospectResult.rows[0].id;
    }

    // Add to list (ignore if already exists)
    await db.query(
      `INSERT INTO list_members (list_id, prospect_id, organizer_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (list_id, prospect_id) DO NOTHING`,
      [listId, prospectId, organizerId]
    );

    res.status(201).json({ success: true, prospect_id: prospectId });
  } catch (err) {
    console.error('POST /api/lists/:id/add-manual error:', err);
    res.status(500).json({ error: err.message || 'Failed to add prospect' });
  }
});

// POST /api/lists/:id/import-bulk - Import multiple prospects from CSV/Excel data
router.post('/:id/import-bulk', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const listId = req.params.id;
    const { prospects } = req.body;

    if (!prospects || !Array.isArray(prospects) || prospects.length === 0) {
      return res.status(400).json({ error: 'Prospects array is required' });
    }

    if (prospects.length > 5000) {
      return res.status(400).json({ error: 'Maximum 5000 prospects per import' });
    }

    // Check list exists
    const listCheck = await db.query(
      'SELECT id FROM lists WHERE id = $1 AND organizer_id = $2',
      [listId, organizerId]
    );

    if (listCheck.rows.length === 0) {
      return res.status(404).json({ error: 'List not found' });
    }

    let imported = 0;
    let skipped = 0;
    let errors = [];

    for (const p of prospects) {
      try {
        if (!p.email || typeof p.email !== 'string' || !p.email.includes('@')) {
          skipped++;
          continue;
        }

        const trimmedEmail = p.email.trim().toLowerCase();

        // Check if prospect exists
        let prospectId;
        const existingProspect = await db.query(
          'SELECT id FROM prospects WHERE organizer_id = $1 AND LOWER(email) = $2',
          [organizerId, trimmedEmail]
        );

        if (existingProspect.rows.length > 0) {
          prospectId = existingProspect.rows[0].id;
        } else {
          // Create new prospect
          const prospectResult = await db.query(
            `INSERT INTO prospects (organizer_id, email, name, company, country, source_type, source_ref)
             VALUES ($1, $2, $3, $4, $5, 'import', 'Bulk import')
             RETURNING id`,
            [
              organizerId,
              trimmedEmail,
              p.name?.trim() || null,
              p.company?.trim() || null,
              p.country?.trim() || null
            ]
          );
          prospectId = prospectResult.rows[0].id;
        }

        // Add to list
        await db.query(
          `INSERT INTO list_members (list_id, prospect_id, organizer_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (list_id, prospect_id) DO NOTHING`,
          [listId, prospectId, organizerId]
        );

        imported++;
      } catch (rowErr) {
        errors.push({ email: p.email, error: rowErr.message });
        skipped++;
      }
    }

    res.status(201).json({
      success: true,
      imported,
      skipped,
      total: prospects.length,
      errors: errors.slice(0, 10) // Return first 10 errors only
    });
  } catch (err) {
    console.error('POST /api/lists/:id/import-bulk error:', err);
    res.status(500).json({ error: err.message || 'Failed to import prospects' });
  }
});

// POST /api/lists/create-empty - Create empty list for manual/import use
router.post('/create-empty', authRequired, async (req, res) => {
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
      `INSERT INTO lists (organizer_id, name, type) VALUES ($1, $2, 'manual') RETURNING id, name, created_at`,
      [organizerId, trimmedName]
    );

    res.status(201).json({
      id: result.rows[0].id,
      name: result.rows[0].name,
      created_at: result.rows[0].created_at,
      total_leads: 0,
      verified_count: 0,
      unverified_count: 0
    });
  } catch (err) {
    console.error('POST /api/lists/create-empty error:', err);
    res.status(500).json({ error: err.message || 'Failed to create list' });
  }
});
