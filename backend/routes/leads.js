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

// GET /api/leads - List all leads (from prospects table)
router.get('/', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 500;
    const offset = (page - 1) * limit;

    const search = req.query.search || '';
    const verificationStatus = req.query.verification_status || '';
    const country = req.query.country || '';

    let conditions = ['organizer_id = $1'];
    let params = [organizerId];
    let paramIndex = 2;

    if (search.trim()) {
      conditions.push(`(
        LOWER(email) LIKE LOWER($${paramIndex}) OR
        LOWER(name) LIKE LOWER($${paramIndex}) OR
        LOWER(company) LIKE LOWER($${paramIndex})
      )`);
      params.push(`%${search.trim()}%`);
      paramIndex++;
    }

    if (verificationStatus.trim()) {
      conditions.push(`verification_status = $${paramIndex}`);
      params.push(verificationStatus.trim());
      paramIndex++;
    }

    if (country.trim()) {
      conditions.push(`LOWER(country) LIKE LOWER($${paramIndex})`);
      params.push(`%${country.trim()}%`);
      paramIndex++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await db.query(
      `SELECT COUNT(*) FROM prospects ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const dataResult = await db.query(
      `
      SELECT
        id,
        email,
        name,
        company,
        country,
        verification_status,
        source_type,
        source_ref,
        tags,
        meta,
        created_at
      FROM prospects
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `,
      [...params, limit, offset]
    );

    res.json({
      page,
      limit,
      total,
      leads: dataResult.rows.map(row => ({
        ...row,
        tags: row.tags || [],
        phone: row.meta?.phone || null,
        website: row.meta?.website || null
      }))
    });
  } catch (err) {
    console.error('GET /api/leads error:', err);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

/**
 * Import leads to prospects table
 * POST /api/leads/import
 * 
 * Accepts TWO formats:
 * 1. { leads: [{ email, name, company, ... }] } - Frontend format
 * 2. { result_ids: [uuid, ...] } - Mining result IDs
 * 
 * Additional options:
 * - tags: string[] - Tags to add to all imported leads
 * - create_list: boolean - Whether to create a list with imported leads
 * - list_name: string - Name for the new list (required if create_list is true)
 */
router.post('/import', authRequired, async (req, res) => {
  const client = await db.connect();
  
  try {
    const organizerId = req.auth.organizer_id;
    const { leads, result_ids, tags, create_list, list_name } = req.body;

    await client.query('BEGIN');

    // Determine which format was sent
    let leadsToImport = [];

    if (Array.isArray(leads) && leads.length > 0) {
      // Frontend format - leads array with full data
      console.log(`Importing ${leads.length} leads directly for organizer ${organizerId}`);
      leadsToImport = leads;
    } else if (Array.isArray(result_ids) && result_ids.length > 0) {
      // Mining results format - fetch from DB
      console.log(`Importing ${result_ids.length} mining results for organizer ${organizerId}`);
      
      const resultsQuery = await client.query(`
        SELECT mr.* 
        FROM mining_results mr
        JOIN mining_jobs mj ON mr.job_id = mj.id
        WHERE mr.id = ANY($1) AND mj.organizer_id = $2
      `, [result_ids, organizerId]);

      if (resultsQuery.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'No valid mining results found' });
      }

      // Convert mining_results format to leads format
      leadsToImport = resultsQuery.rows.map(r => ({
        email: Array.isArray(r.emails) && r.emails.length > 0 ? r.emails[0] : null,
        name: r.contact_name,
        company: r.company_name,
        country: r.country,
        source_type: 'mining',
        source_ref: r.job_id,
        verification_status: r.verification_status,
        meta: {
          phone: r.phone,
          website: r.website,
          job_title: r.job_title,
          city: r.city,
          address: r.address,
          source_url: r.source_url,
          mining_result_id: r.id
        }
      }));
    } else {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Either leads array or result_ids array is required' });
    }

    // Normalize tags
    let normalizedTags = [];
    if (Array.isArray(tags) && tags.length > 0) {
      normalizedTags = tags
        .map(t => (typeof t === 'string' ? t.trim().toLowerCase() : ''))
        .filter(t => t.length > 0);
    }

    let imported = 0;
    let updated = 0;
    let personsUpserted = 0;
    let affiliationsUpserted = 0;
    const errors = [];
    const importedProspectIds = []; // Track imported prospect IDs for list creation

    for (const lead of leadsToImport) {
      try {
        const email = lead.email ? lead.email.toLowerCase().trim() : null;

        if (!email) {
          errors.push({ email: lead.email, error: 'No valid email' });
          continue;
        }

        // Build meta object
        const meta = lead.meta || {};
        if (lead.phone) meta.phone = lead.phone;
        if (lead.website) meta.website = lead.website;

        // Check if email already exists
        const existingCheck = await client.query(
          'SELECT id, meta, tags FROM prospects WHERE LOWER(email) = LOWER($1) AND organizer_id = $2',
          [email, organizerId]
        );

        if (existingCheck.rows.length > 0) {
          // Update existing - merge meta and tags
          const existingMeta = existingCheck.rows[0].meta || {};
          const existingTags = existingCheck.rows[0].tags || [];
          const mergedMeta = { ...existingMeta, ...meta };
          
          // Merge tags (union of existing and new)
          const mergedTags = [...new Set([...existingTags, ...normalizedTags])];
          
          await client.query(`
            UPDATE prospects SET
              name = COALESCE(NULLIF($1, ''), name),
              company = COALESCE(NULLIF($2, ''), company),
              country = COALESCE(NULLIF($3, ''), country),
              meta = $4,
              tags = $5,
              verification_status = COALESCE(NULLIF($6, ''), verification_status)
            WHERE id = $7
          `, [
            lead.name,
            lead.company,
            lead.country,
            JSON.stringify(mergedMeta),
            mergedTags,
            lead.verification_status,
            existingCheck.rows[0].id
          ]);
          
          importedProspectIds.push(existingCheck.rows[0].id);
          updated++;
        } else {
          // Insert new
          const insertResult = await client.query(`
            INSERT INTO prospects (
              organizer_id, email, name, company, country,
              source_type, source_ref, verification_status, meta, tags, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
            RETURNING id
          `, [
            organizerId,
            email,
            lead.name || null,
            lead.company || null,
            lead.country || null,
            lead.source_type || 'import',
            lead.source_ref || null,
            lead.verification_status || 'unverified',
            JSON.stringify(meta),
            normalizedTags
          ]);
          
          importedProspectIds.push(insertResult.rows[0].id);
          imported++;
        }

        // If we have mining_result_id, mark it as imported
        if (meta.mining_result_id) {
          await client.query(
            'UPDATE mining_results SET status = $1, updated_at = NOW() WHERE id = $2',
            ['imported', meta.mining_result_id]
          );
        }

        // --- CANONICAL: persons table UPSERT (Phase 3 dual-write) ---
        const nameParts = (lead.name || '').trim().split(/\s+/);
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
          [organizerId, email, firstName, lastName]
        );
        personsUpserted++;
        const personId = personResult.rows[0].id;

        // --- CANONICAL: affiliations table UPSERT (if company present) ---
        if (lead.company) {
          await client.query(
            `INSERT INTO affiliations (organizer_id, person_id, company_name, position, country_code, city, website, phone, source_type, source_ref)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (organizer_id, person_id, LOWER(company_name))
             WHERE company_name IS NOT NULL
             DO UPDATE SET
               position = COALESCE(NULLIF(EXCLUDED.position, ''), affiliations.position),
               country_code = COALESCE(NULLIF(EXCLUDED.country_code, ''), affiliations.country_code),
               city = COALESCE(NULLIF(EXCLUDED.city, ''), affiliations.city),
               website = COALESCE(NULLIF(EXCLUDED.website, ''), affiliations.website),
               phone = COALESCE(NULLIF(EXCLUDED.phone, ''), affiliations.phone)`,
            [
              organizerId,
              personId,
              lead.company,
              meta.job_title || null,
              lead.country ? lead.country.substring(0, 2).toUpperCase() : null,
              meta.city || null,
              meta.website || lead.website || null,
              meta.phone || lead.phone || null,
              lead.source_type || 'import',
              lead.source_ref || null
            ]
          );
          affiliationsUpserted++;
        }

      } catch (insertErr) {
        console.error(`Error importing lead ${lead.email}:`, insertErr.message);
        errors.push({ email: lead.email, error: insertErr.message });
      }
    }

    // Create list if requested
    let createdList = null;
    if (create_list && list_name && importedProspectIds.length > 0) {
      const trimmedListName = list_name.trim();
      
      if (trimmedListName) {
        // Create the list
        const listResult = await client.query(`
          INSERT INTO lists (organizer_id, name, created_at)
          VALUES ($1, $2, NOW())
          RETURNING id, name
        `, [organizerId, trimmedListName]);
        
        createdList = listResult.rows[0];
        
        // Add prospects to list_members
        for (const prospectId of importedProspectIds) {
          await client.query(`
            INSERT INTO list_members (organizer_id, list_id, prospect_id, created_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT DO NOTHING
          `, [organizerId, createdList.id, prospectId]);
        }
        
        console.log(`Created list "${trimmedListName}" with ${importedProspectIds.length} members`);
      }
    }

    await client.query('COMMIT');

    console.log(`Import complete: ${imported} new, ${updated} updated, ${errors.length} errors`);

    res.json({
      success: true,
      imported,
      updated,
      total: leadsToImport.length,
      canonical_sync: {
        persons_upserted: personsUpserted,
        affiliations_upserted: affiliationsUpserted
      },
      tags_applied: normalizedTags,
      list_created: createdList,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/leads/import error:', err);
    res.status(500).json({ error: 'Failed to import leads', details: err.message });
  } finally {
    client.release();
  }
});

// POST /api/leads/:id/tags
router.post('/:id/tags', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const leadId = req.params.id;
    const { tags } = req.body;

    const checkResult = await db.query(
      'SELECT id FROM prospects WHERE id = $1 AND organizer_id = $2',
      [leadId, organizerId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    let normalizedTags = [];
    if (Array.isArray(tags)) {
      normalizedTags = tags
        .map(t => (typeof t === 'string' ? t.trim().toLowerCase() : ''))
        .filter(t => t.length > 0);
    }

    const updateResult = await db.query(
      'UPDATE prospects SET tags = $1 WHERE id = $2 RETURNING id, tags',
      [normalizedTags, leadId]
    );

    res.json({
      id: updateResult.rows[0].id,
      tags: updateResult.rows[0].tags || []
    });
  } catch (err) {
    console.error('POST /api/leads/:id/tags error:', err);
    res.status(500).json({ error: 'Failed to update tags' });
  }
});

// POST /api/leads/bulk-tags
router.post('/bulk-tags', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const { lead_ids, tags } = req.body;

    if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
      return res.status(400).json({ error: 'lead_ids array is required' });
    }

    if (!Array.isArray(tags)) {
      return res.status(400).json({ error: 'tags array is required' });
    }

    const normalizedTags = tags
      .map(t => (typeof t === 'string' ? t.trim().toLowerCase() : ''))
      .filter(t => t.length > 0);

    if (normalizedTags.length === 0) {
      return res.status(400).json({ error: 'At least one valid tag is required' });
    }

    const verifyResult = await db.query(
      'SELECT id FROM prospects WHERE id = ANY($1) AND organizer_id = $2',
      [lead_ids, organizerId]
    );

    const validIds = verifyResult.rows.map(r => r.id);

    if (validIds.length === 0) {
      return res.status(404).json({ error: 'No valid leads found' });
    }

    const updateResult = await db.query(
      `
      UPDATE prospects 
      SET tags = (
        SELECT ARRAY(
          SELECT DISTINCT unnest(COALESCE(tags, '{}') || $1::text[])
        )
      )
      WHERE id = ANY($2) AND organizer_id = $3
      RETURNING id, tags
      `,
      [normalizedTags, validIds, organizerId]
    );

    res.json({
      updated_count: updateResult.rows.length,
      leads: updateResult.rows.map(r => ({
        id: r.id,
        tags: r.tags || []
      }))
    });
  } catch (err) {
    console.error('POST /api/leads/bulk-tags error:', err);
    res.status(500).json({ error: 'Failed to update tags' });
  }
});

module.exports = router;
