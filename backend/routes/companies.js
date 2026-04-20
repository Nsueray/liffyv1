const express = require('express');
const router = express.Router();
const db = require('../db');
const { authRequired } = require('../middleware/auth');

/**
 * GET /api/companies
 * Aggregated company view from affiliations table.
 * Filters: search, industry, country, min_contacts
 */
router.get('/', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const industry = (req.query.industry || '').trim();
    const country = (req.query.country || '').trim();
    const minContacts = parseInt(req.query.min_contacts) || 0;
    const sortBy = req.query.sort_by || 'contact_count';
    const sortOrder = (req.query.sort_order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const where = ["a.organizer_id = $1", "a.company_name IS NOT NULL", "TRIM(a.company_name) != ''"];
    const params = [organizerId];
    let paramIdx = 2;

    if (search) {
      where.push(`a.company_name ILIKE $${paramIdx}`);
      params.push(`%${search}%`);
      paramIdx++;
    }

    if (industry) {
      where.push(`a.industry = $${paramIdx}`);
      params.push(industry);
      paramIdx++;
    }

    if (country) {
      where.push(`a.country ILIKE $${paramIdx}`);
      params.push(`%${country}%`);
      paramIdx++;
    }

    const whereClause = where.join(' AND ');

    const havingClauses = [];
    if (minContacts > 0) {
      havingClauses.push(`COUNT(DISTINCT a.person_id) >= $${paramIdx}`);
      params.push(minContacts);
      paramIdx++;
    }
    const havingSQL = havingClauses.length > 0 ? `HAVING ${havingClauses.join(' AND ')}` : '';

    // Allowed sort columns
    const sortColumns = {
      contact_count: 'contact_count',
      company_name: 'company_name',
      industry: 'industry',
      country: 'country',
      verified_count: 'verified_count',
      last_added: 'last_added',
    };
    const orderCol = sortColumns[sortBy] || 'contact_count';

    // Count query
    const countSQL = `
      SELECT COUNT(*) as total FROM (
        SELECT LOWER(TRIM(a.company_name)) as company_key
        FROM affiliations a
        JOIN persons p ON p.id = a.person_id AND p.organizer_id = a.organizer_id
        WHERE ${whereClause}
        GROUP BY LOWER(TRIM(a.company_name))
        ${havingSQL}
      ) sub
    `;
    const countRes = await db.query(countSQL, params);
    const total = parseInt(countRes.rows[0].total);

    // Data query
    const dataParams = [...params, limit, offset];
    const dataSQL = `
      SELECT
        LOWER(TRIM(a.company_name)) as company_key,
        MAX(a.company_name) as company_name,
        MAX(a.industry) as industry,
        COUNT(DISTINCT a.person_id) as contact_count,
        COUNT(DISTINCT CASE WHEN p.email_status = 'valid' THEN a.person_id END) as verified_count,
        MAX(a.country) as country,
        MAX(a.created_at) as last_added
      FROM affiliations a
      JOIN persons p ON p.id = a.person_id AND p.organizer_id = a.organizer_id
      WHERE ${whereClause}
      GROUP BY LOWER(TRIM(a.company_name))
      ${havingSQL}
      ORDER BY ${orderCol} ${sortOrder}
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;
    const dataRes = await db.query(dataSQL, dataParams);

    // Get industry list for filter dropdown
    const industriesRes = await db.query(
      `SELECT DISTINCT industry FROM affiliations
       WHERE organizer_id = $1 AND industry IS NOT NULL AND TRIM(industry) != ''
       ORDER BY industry`,
      [organizerId]
    );

    res.json({
      companies: dataRes.rows,
      total,
      page,
      limit,
      industries: industriesRes.rows.map(r => r.industry),
    });
  } catch (err) {
    console.error('[companies] GET / error:', err);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

/**
 * GET /api/companies/:companyName/contacts
 * Returns all persons affiliated with the given company.
 */
router.get('/:companyName/contacts', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const companyName = decodeURIComponent(req.params.companyName).trim();

    if (!companyName) {
      return res.status(400).json({ error: 'Company name is required' });
    }

    const result = await db.query(
      `SELECT
        p.id as person_id,
        p.email,
        p.first_name,
        p.last_name,
        p.phone,
        p.email_status,
        p.created_at as person_created_at,
        a.company_name,
        a.job_title,
        a.industry,
        a.country,
        a.source_url,
        a.created_at as affiliation_created_at
      FROM affiliations a
      JOIN persons p ON p.id = a.person_id AND p.organizer_id = a.organizer_id
      WHERE a.organizer_id = $1
        AND LOWER(TRIM(a.company_name)) = LOWER($2)
      ORDER BY p.last_name, p.first_name, p.email`,
      [organizerId, companyName]
    );

    res.json({
      company_name: companyName,
      contacts: result.rows,
      total: result.rows.length,
    });
  } catch (err) {
    console.error('[companies] GET /:companyName/contacts error:', err);
    res.status(500).json({ error: 'Failed to fetch company contacts' });
  }
});

module.exports = router;
