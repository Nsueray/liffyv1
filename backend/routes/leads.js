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
 */
router.post('/import', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const { leads, result_ids } = req.body;

    // Determine which format was sent
    let leadsToImport = [];

    if (Array.isArray(leads) && leads.length > 0) {
      // Frontend format - leads array with full data
      console.log(`Importing ${leads.length} leads directly for organizer ${organizerId}`);
      leadsToImport = leads;
    } else if (Array.isArray(result_ids) && result_ids.length > 0) {
      // Mining results format - fetch from DB
      console.log(`Importing ${result_ids.length} mining results for organizer ${organizerId}`);
      
      const resultsQuery = await db.query(`
        SELECT mr.* 
        FROM mining_results mr
        JOIN mining_jobs mj ON mr.job_id = mj.id
        WHERE mr.id = ANY($1) AND mj.organizer_id = $2
      `, [result_ids, organizerId]);

      if (resultsQuery.rows.length === 0) {
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
      return res.status(400).json({ error: 'Either leads array or result_ids array is required' });
    }

    let imported = 0;
    let updated = 0;
    const errors = [];

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
        const existingCheck = await db.query(
          'SELECT id, meta FROM prospects WHERE LOWER(email) = LOWER($1) AND organizer_id = $2',
          [email, organizerId]
        );

        if (existingCheck.rows.length > 0) {
          // Update existing - merge meta
          const existingMeta = existingCheck.rows[0].meta || {};
          const mergedMeta = { ...existingMeta, ...meta };
          
          await db.query(`
            UPDATE prospects SET
              name = COALESCE(NULLIF($1, ''), name),
              company = COALESCE(NULLIF($2, ''), company),
              country = COALESCE(NULLIF($3, ''), country),
              meta = $4,
              verification_status = COALESCE(NULLIF($5, ''), verification_status)
            WHERE id = $6
          `, [
            lead.name,
            lead.company,
            lead.country,
            JSON.stringify(mergedMeta),
            lead.verification_status,
            existingCheck.rows[0].id
          ]);
          updated++;
        } else {
          // Insert new
          await db.query(`
            INSERT INTO prospects (
              organizer_id, email, name, company, country,
              source_type, source_ref, verification_status, meta, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
          `, [
            organizerId,
            email,
            lead.name || null,
            lead.company || null,
            lead.country || null,
            lead.source_type || 'import',
            lead.source_ref || null,
            lead.verification_status || 'unverified',
            JSON.stringify(meta)
          ]);
          imported++;
        }

        // If we have mining_result_id, mark it as imported
        if (meta.mining_result_id) {
          await db.query(
            'UPDATE mining_results SET status = $1, updated_at = NOW() WHERE id = $2',
            ['imported', meta.mining_result_id]
          );
        }

      } catch (insertErr) {
        console.error(`Error importing lead ${lead.email}:`, insertErr.message);
        errors.push({ email: lead.email, error: insertErr.message });
      }
    }

    console.log(`Import complete: ${imported} new, ${updated} updated, ${errors.length} errors`);

    res.json({
      success: true,
      imported,
      updated,
      total: leadsToImport.length,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (err) {
    console.error('POST /api/leads/import error:', err);
    res.status(500).json({ error: 'Failed to import leads', details: err.message });
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
