const express = require('express');
const router = express.Router();
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { getHierarchicalScope, canAccessRowHierarchical, isPrivileged, getUserContext } = require('../middleware/userScope');
const { sendEmail } = require('../mailer');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute line item total:
 *   quantity * unit_price * (1 - discount_percent/100) * (1 + tax_percent/100)
 */
function lineTotal(li) {
  const subtotal = Number(li.quantity) * Number(li.unit_price);
  const afterDiscount = subtotal * (1 - Number(li.discount_percent || 0) / 100);
  const afterTax = afterDiscount * (1 + Number(li.tax_percent || 0) / 100);
  return afterTax;
}

/**
 * Derive AF display number: Q/A prefix + office.code + '-' + af_sequence.
 */
function afNumber(quote) {
  const prefix = quote.status === 'signed' ? 'A' : 'Q';
  const code = quote.office_code || '??';
  return `${prefix}${code}-${quote.af_sequence}`;
}

/**
 * Compute quote totals from line items.
 */
function computeTotals(lineItems, exchangeRate) {
  let subtotal = 0;
  let totalDiscount = 0;
  let totalTax = 0;
  let totalM2 = 0;

  for (const li of lineItems) {
    const qty = Number(li.quantity);
    const price = Number(li.unit_price);
    const disc = Number(li.discount_percent || 0);
    const tax = Number(li.tax_percent || 0);
    const sub = qty * price;
    const discAmount = sub * disc / 100;
    const afterDisc = sub - discAmount;
    const taxAmount = afterDisc * tax / 100;

    subtotal += sub;
    totalDiscount += discAmount;
    totalTax += taxAmount;

    if (li.unit_type === 'm2') totalM2 += qty;
  }

  const grandTotal = subtotal - totalDiscount + totalTax;
  const rate = Number(exchangeRate);

  return {
    subtotal: round2(subtotal),
    total_discount: round2(totalDiscount),
    total_tax: round2(totalTax),
    grand_total: round2(grandTotal),
    grand_total_eur: round2(grandTotal * rate),
    total_m2: round2(totalM2),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Load quote with office code for AF number derivation.
 */
async function loadQuote(quoteId, organizerId) {
  const r = await db.query(`
    SELECT q.*, o.code AS office_code
    FROM quotes q
    JOIN offices o ON o.id = q.office_id
    WHERE q.id = $1 AND q.organizer_id = $2
  `, [quoteId, organizerId]);
  return r.rows[0] || null;
}

/**
 * Load line items for a quote.
 */
async function loadLineItems(quoteId) {
  const r = await db.query(`
    SELECT * FROM quote_line_items
    WHERE quote_id = $1
    ORDER BY sort_order, created_at
  `, [quoteId]);
  return r.rows;
}

/**
 * Enrich quote response with computed fields.
 */
function enrichQuote(quote, lineItems) {
  const totals = computeTotals(lineItems, quote.exchange_rate_to_eur);
  const today = new Date().toISOString().slice(0, 10);
  return {
    ...quote,
    af_number: afNumber(quote),
    is_expired: quote.status === 'sent' && quote.valid_until && quote.valid_until < today,
    line_items: lineItems.map(li => ({
      ...li,
      line_total: round2(lineTotal(li)),
    })),
    totals,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE DATA: Expos, Products, Product Prices, Exchange Rates, Offices
// ─────────────────────────────────────────────────────────────────────────────

// === OFFICES (read-only, seed'li) ===

router.get('/offices', authRequired, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM offices ORDER BY code');
    res.json(r.rows);
  } catch (err) {
    console.error('GET /offices error:', err);
    res.status(500).json({ error: err.message });
  }
});

// === OFFICES: assign office to user (Owner only) ===

router.patch('/users/:userId/office', authRequired, async (req, res) => {
  try {
    if (!isPrivileged(req)) {
      return res.status(403).json({ error: 'Owner/admin only' });
    }
    const { userId } = req.params;
    const { office_id } = req.body; // null to unassign

    if (office_id) {
      const officeCheck = await db.query('SELECT id FROM offices WHERE id = $1', [office_id]);
      if (officeCheck.rows.length === 0) return res.status(404).json({ error: 'Office not found' });
    }

    await db.query(
      'UPDATE users SET office_id = $1 WHERE id = $2 AND organizer_id = $3',
      [office_id || null, userId, req.auth.organizer_id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /users/:userId/office error:', err);
    res.status(500).json({ error: err.message });
  }
});

// === EXCHANGE RATES ===

router.get('/exchange-rates', authRequired, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM exchange_rates ORDER BY currency');
    res.json(r.rows);
  } catch (err) {
    console.error('GET /exchange-rates error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/exchange-rates/:currency', authRequired, async (req, res) => {
  try {
    if (!isPrivileged(req)) {
      return res.status(403).json({ error: 'Owner/admin only' });
    }
    const currency = req.params.currency.toUpperCase().trim();
    if (currency.length !== 3) return res.status(400).json({ error: 'Currency must be 3 chars (ISO 4217)' });

    const { rate_to_eur } = req.body;
    if (!rate_to_eur || Number(rate_to_eur) <= 0) {
      return res.status(400).json({ error: 'rate_to_eur must be > 0' });
    }

    const { userId } = getUserContext(req);
    const r = await db.query(`
      INSERT INTO exchange_rates (currency, rate_to_eur, updated_at, updated_by)
      VALUES ($1, $2, NOW(), $3)
      ON CONFLICT (currency) DO UPDATE SET
        rate_to_eur = EXCLUDED.rate_to_eur,
        updated_at = NOW(),
        updated_by = EXCLUDED.updated_by
      RETURNING *
    `, [currency, rate_to_eur, userId]);
    res.json(r.rows[0]);
  } catch (err) {
    console.error('PUT /exchange-rates/:currency error:', err);
    res.status(500).json({ error: err.message });
  }
});

// === EXPOS CRUD ===

router.get('/expos', authRequired, async (req, res) => {
  try {
    const orgId = req.auth.organizer_id;
    const activeOnly = req.query.active_only !== 'false'; // default true
    let sql = 'SELECT * FROM expos WHERE organizer_id = $1';
    const params = [orgId];
    if (activeOnly) sql += ' AND is_active = TRUE';
    sql += ' ORDER BY start_date DESC NULLS LAST, name';
    const r = await db.query(sql, params);
    res.json(r.rows);
  } catch (err) {
    console.error('GET /expos error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/expos/:id', authRequired, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM expos WHERE id = $1 AND organizer_id = $2', [req.params.id, req.auth.organizer_id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Expo not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('GET /expos/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/expos', authRequired, async (req, res) => {
  try {
    if (!isPrivileged(req)) return res.status(403).json({ error: 'Owner/admin only' });
    const orgId = req.auth.organizer_id;
    const { userId } = getUserContext(req);
    const { name, country_code, city, start_date, end_date, payment_deadline, default_currency } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    const r = await db.query(`
      INSERT INTO expos (organizer_id, name, country_code, city, start_date, end_date, payment_deadline, default_currency, created_by_user_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [orgId, name.trim(), country_code || null, city || null, start_date || null, end_date || null, payment_deadline || null, default_currency || null, userId]);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('POST /expos error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/expos/:id', authRequired, async (req, res) => {
  try {
    if (!isPrivileged(req)) return res.status(403).json({ error: 'Owner/admin only' });
    const { name, country_code, city, start_date, end_date, payment_deadline, default_currency, is_active } = req.body;
    const r = await db.query(`
      UPDATE expos SET
        name = COALESCE($3, name),
        country_code = $4,
        city = $5,
        start_date = $6,
        end_date = $7,
        payment_deadline = $8,
        default_currency = $9,
        is_active = COALESCE($10, is_active)
      WHERE id = $1 AND organizer_id = $2
      RETURNING *
    `, [req.params.id, req.auth.organizer_id, name || null, country_code || null, city || null, start_date || null, end_date || null, payment_deadline || null, default_currency || null, is_active != null ? is_active : null]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Expo not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('PUT /expos/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/expos/:id', authRequired, async (req, res) => {
  try {
    if (!isPrivileged(req)) return res.status(403).json({ error: 'Owner/admin only' });
    // Check if any quotes reference this expo
    const usageCheck = await db.query('SELECT COUNT(*) FROM quotes WHERE expo_id = $1', [req.params.id]);
    if (parseInt(usageCheck.rows[0].count) > 0) {
      return res.status(400).json({ error: 'Cannot delete expo with existing quotes. Deactivate instead.' });
    }
    const r = await db.query('DELETE FROM expos WHERE id = $1 AND organizer_id = $2 RETURNING id', [req.params.id, req.auth.organizer_id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Expo not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /expos/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// === PRODUCTS CRUD ===

router.get('/products', authRequired, async (req, res) => {
  try {
    const orgId = req.auth.organizer_id;
    const activeOnly = req.query.active_only !== 'false';
    let sql = 'SELECT * FROM products WHERE organizer_id = $1';
    if (activeOnly) sql += ' AND is_active = TRUE';
    sql += ' ORDER BY category NULLS LAST, name';
    const r = await db.query(sql, [orgId]);
    res.json(r.rows);
  } catch (err) {
    console.error('GET /products error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/products/:id', authRequired, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM products WHERE id = $1 AND organizer_id = $2', [req.params.id, req.auth.organizer_id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    // Include prices
    const prices = await db.query(`
      SELECT pp.*, o.code AS office_code, o.name AS office_name
      FROM product_prices pp
      JOIN offices o ON o.id = pp.office_id
      WHERE pp.product_id = $1
      ORDER BY o.code
    `, [req.params.id]);
    res.json({ ...r.rows[0], prices: prices.rows });
  } catch (err) {
    console.error('GET /products/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/products', authRequired, async (req, res) => {
  try {
    if (!isPrivileged(req)) return res.status(403).json({ error: 'Owner/admin only' });
    const orgId = req.auth.organizer_id;
    const { userId } = getUserContext(req);
    const { code, name, category, unit_type } = req.body;
    if (!code || !code.trim()) return res.status(400).json({ error: 'code is required' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!unit_type || !['m2', 'unit'].includes(unit_type)) return res.status(400).json({ error: 'unit_type must be m2 or unit' });

    const r = await db.query(`
      INSERT INTO products (organizer_id, code, name, category, unit_type, created_by_user_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [orgId, code.trim(), name.trim(), category || null, unit_type, userId]);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.constraint === 'uq_products_organizer_code') {
      return res.status(409).json({ error: 'Product code already exists' });
    }
    console.error('POST /products error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/products/:id', authRequired, async (req, res) => {
  try {
    if (!isPrivileged(req)) return res.status(403).json({ error: 'Owner/admin only' });
    const { code, name, category, unit_type, is_active } = req.body;
    if (unit_type && !['m2', 'unit'].includes(unit_type)) return res.status(400).json({ error: 'unit_type must be m2 or unit' });

    const r = await db.query(`
      UPDATE products SET
        code = COALESCE($3, code),
        name = COALESCE($4, name),
        category = $5,
        unit_type = COALESCE($6, unit_type),
        is_active = COALESCE($7, is_active)
      WHERE id = $1 AND organizer_id = $2
      RETURNING *
    `, [req.params.id, req.auth.organizer_id, code || null, name || null, category !== undefined ? category : null, unit_type || null, is_active != null ? is_active : null]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    res.json(r.rows[0]);
  } catch (err) {
    if (err.constraint === 'uq_products_organizer_code') {
      return res.status(409).json({ error: 'Product code already exists' });
    }
    console.error('PUT /products/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// === PRODUCT PRICES CRUD ===

router.get('/products/:productId/prices', authRequired, async (req, res) => {
  try {
    const r = await db.query(`
      SELECT pp.*, o.code AS office_code, o.name AS office_name
      FROM product_prices pp
      JOIN offices o ON o.id = pp.office_id
      WHERE pp.product_id = $1
      ORDER BY o.code
    `, [req.params.productId]);
    res.json(r.rows);
  } catch (err) {
    console.error('GET /products/:id/prices error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/products/:productId/prices/:officeId', authRequired, async (req, res) => {
  try {
    if (!isPrivileged(req)) return res.status(403).json({ error: 'Owner/admin only' });
    const { userId } = getUserContext(req);
    const { currency, unit_price } = req.body;
    if (!currency || currency.length !== 3) return res.status(400).json({ error: 'currency must be 3 chars' });
    if (unit_price == null || Number(unit_price) < 0) return res.status(400).json({ error: 'unit_price must be >= 0' });

    const r = await db.query(`
      INSERT INTO product_prices (product_id, office_id, currency, unit_price, created_by_user_id)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT ON CONSTRAINT uq_product_prices_product_office
      DO UPDATE SET
        currency = EXCLUDED.currency,
        unit_price = EXCLUDED.unit_price
      RETURNING *
    `, [req.params.productId, req.params.officeId, currency.toUpperCase(), unit_price, userId]);
    res.json(r.rows[0]);
  } catch (err) {
    console.error('PUT /products/:productId/prices/:officeId error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// QUOTES
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/quotes — Create quote
router.post('/', authRequired, async (req, res) => {
  try {
    const orgId = req.auth.organizer_id;
    const { userId } = getUserContext(req);
    const {
      expo_id, company_id, person_id, office_id,
      currency, exchange_rate_to_eur, valid_until, notes,
      sales_owner_user_id, subject: customSubject,
      line_items,
    } = req.body;

    // Required fields
    if (!expo_id) return res.status(400).json({ error: 'expo_id is required' });
    if (!company_id) return res.status(400).json({ error: 'company_id is required' });

    // Resolve office: explicit > user's office
    let resolvedOfficeId = office_id;
    if (!resolvedOfficeId) {
      const userRow = await db.query('SELECT office_id FROM users WHERE id = $1', [userId]);
      resolvedOfficeId = userRow.rows[0]?.office_id;
    }
    if (!resolvedOfficeId) return res.status(400).json({ error: 'office_id is required (user has no default office)' });

    // Load office
    const officeRow = await db.query('SELECT id, code, default_currency FROM offices WHERE id = $1', [resolvedOfficeId]);
    if (officeRow.rows.length === 0) return res.status(404).json({ error: 'Office not found' });
    const office = officeRow.rows[0];

    // Resolve currency: explicit > office default
    const resolvedCurrency = (currency || office.default_currency || '').toUpperCase().trim();
    if (!resolvedCurrency || resolvedCurrency.length !== 3) {
      return res.status(400).json({ error: 'currency is required (office has no default currency)' });
    }

    // Resolve exchange rate: explicit > from exchange_rates table
    let resolvedRate = exchange_rate_to_eur;
    if (!resolvedRate) {
      const rateRow = await db.query('SELECT rate_to_eur FROM exchange_rates WHERE currency = $1', [resolvedCurrency]);
      if (rateRow.rows.length === 0) {
        return res.status(400).json({ error: `No exchange rate found for ${resolvedCurrency}. Add rate first.` });
      }
      resolvedRate = rateRow.rows[0].rate_to_eur;
    }
    if (Number(resolvedRate) <= 0) return res.status(400).json({ error: 'exchange_rate_to_eur must be > 0' });

    // Load expo for valid_until prefill and subject generation
    const expoRow = await db.query('SELECT name, payment_deadline FROM expos WHERE id = $1 AND organizer_id = $2', [expo_id, orgId]);
    if (expoRow.rows.length === 0) return res.status(404).json({ error: 'Expo not found' });
    const expo = expoRow.rows[0];

    // Load company for subject generation
    const companyRow = await db.query('SELECT name FROM companies WHERE id = $1 AND organizer_id = $2', [company_id, orgId]);
    if (companyRow.rows.length === 0) return res.status(404).json({ error: 'Company not found' });
    const company = companyRow.rows[0];

    // Validate person if provided
    if (person_id) {
      const personCheck = await db.query('SELECT id FROM persons WHERE id = $1 AND organizer_id = $2', [person_id, orgId]);
      if (personCheck.rows.length === 0) return res.status(404).json({ error: 'Person not found' });
    }

    // Resolve sales owner: explicit > current user
    const resolvedOwner = sales_owner_user_id || userId;

    // Pre-resolve unit_types from products for m2 calculation
    const items = line_items || [];
    let totalM2 = 0;
    for (const li of items) {
      let uType = li.unit_type;
      if (!uType && li.product_id) {
        const pRow = await db.query('SELECT unit_type FROM products WHERE id = $1', [li.product_id]);
        if (pRow.rows[0]) uType = pRow.rows[0].unit_type;
      }
      if (uType === 'm2') totalM2 += Number(li.quantity || 0);
    }

    // Generate subject: {Expo}-{Company}-{totalM2}SQM or {Expo}-{Company}
    const resolvedSubject = customSubject || (totalM2 > 0
      ? `${expo.name}-${company.name}-${totalM2}SQM`
      : `${expo.name}-${company.name}`);

    // Resolve valid_until: explicit > expo.payment_deadline
    const resolvedValidUntil = valid_until || expo.payment_deadline || null;

    // Insert quote
    const quoteRes = await db.query(`
      INSERT INTO quotes (
        organizer_id, office_id, expo_id, company_id, person_id,
        sales_owner_user_id, subject, status, currency, exchange_rate_to_eur,
        valid_until, notes, created_by_user_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11,$12)
      RETURNING *
    `, [
      orgId, resolvedOfficeId, expo_id, company_id, person_id || null,
      resolvedOwner, resolvedSubject, resolvedCurrency, resolvedRate,
      resolvedValidUntil, notes || null, userId,
    ]);
    const quote = quoteRes.rows[0];

    // Insert line items
    const insertedItems = [];
    for (let i = 0; i < items.length; i++) {
      const li = items[i];
      if (!li.description && !li.product_id) continue;

      // If product_id given, snapshot description/unit_type and prefill unit_price
      let desc = li.description;
      let unitType = li.unit_type;
      let unitPrice = li.unit_price;

      if (li.product_id) {
        const prodRow = await db.query('SELECT name, unit_type FROM products WHERE id = $1 AND organizer_id = $2', [li.product_id, orgId]);
        if (prodRow.rows[0]) {
          desc = desc || prodRow.rows[0].name;
          unitType = unitType || prodRow.rows[0].unit_type;
          // Prefill price from product_prices for this office
          if (unitPrice == null) {
            const priceRow = await db.query(
              'SELECT unit_price FROM product_prices WHERE product_id = $1 AND office_id = $2',
              [li.product_id, resolvedOfficeId]
            );
            if (priceRow.rows[0]) unitPrice = priceRow.rows[0].unit_price;
          }
        }
      }

      if (!desc) continue;
      if (!unitType || !['m2', 'unit'].includes(unitType)) unitType = 'unit';
      if (unitPrice == null) unitPrice = 0;

      const liRes = await db.query(`
        INSERT INTO quote_line_items (
          quote_id, product_id, description, unit_type, quantity,
          unit_price, discount_percent, tax_percent, sort_order
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING *
      `, [
        quote.id, li.product_id || null, desc, unitType,
        li.quantity || 1, unitPrice,
        li.discount_percent || 0, li.tax_percent || 0, li.sort_order || i,
      ]);
      insertedItems.push(liRes.rows[0]);
    }

    // Return enriched response
    const fullQuote = await loadQuote(quote.id, orgId);
    res.status(201).json(enrichQuote(fullQuote, insertedItems));
  } catch (err) {
    console.error('POST /api/quotes error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/quotes — List quotes
router.get('/', authRequired, async (req, res) => {
  try {
    const orgId = req.auth.organizer_id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;

    const { status, expo_id, company_id, search } = req.query;

    const where = ['q.organizer_id = $1'];
    const params = [orgId];
    let idx = 2;

    if (status) {
      where.push(`q.status = $${idx}`);
      params.push(status);
      idx++;
    }
    if (expo_id) {
      where.push(`q.expo_id = $${idx}`);
      params.push(expo_id);
      idx++;
    }
    if (company_id) {
      where.push(`q.company_id = $${idx}`);
      params.push(company_id);
      idx++;
    }
    if (search && search.trim()) {
      where.push(`(q.subject ILIKE $${idx} OR c.name ILIKE $${idx} OR CAST(q.af_sequence AS TEXT) LIKE $${idx})`);
      params.push(`%${search.trim()}%`);
      idx++;
    }

    // Scope: sales_owner_user_id hierarchy
    const scope = getHierarchicalScope(req, 'q.sales_owner_user_id', idx);
    idx = scope.nextIndex;

    const whereClause = where.join(' AND ');

    const countRes = await db.query(`
      SELECT COUNT(*) FROM quotes q
      LEFT JOIN companies c ON c.id = q.company_id
      WHERE ${whereClause} ${scope.sql}
    `, [...params, ...scope.params]);
    const total = parseInt(countRes.rows[0].count, 10);

    const dataRes = await db.query(`
      SELECT q.*, o.code AS office_code,
             c.name AS company_name, e.name AS expo_name,
             p.first_name AS person_first_name, p.last_name AS person_last_name, p.email AS person_email,
             u.first_name AS owner_first_name, u.last_name AS owner_last_name,
             cr.first_name AS creator_first_name, cr.last_name AS creator_last_name
      FROM quotes q
      JOIN offices o ON o.id = q.office_id
      LEFT JOIN companies c ON c.id = q.company_id
      LEFT JOIN expos e ON e.id = q.expo_id
      LEFT JOIN persons p ON p.id = q.person_id
      LEFT JOIN users u ON u.id = q.sales_owner_user_id
      LEFT JOIN users cr ON cr.id = q.created_by_user_id
      WHERE ${whereClause} ${scope.sql}
      ORDER BY q.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `, [...params, ...scope.params, limit, offset]);

    // Load line items for each quote for totals
    const quotes = [];
    for (const row of dataRes.rows) {
      const items = await loadLineItems(row.id);
      quotes.push(enrichQuote(row, items));
    }

    res.json({ quotes, total, page, limit });
  } catch (err) {
    console.error('GET /api/quotes error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/quotes/:id — Quote detail
router.get('/:id', authRequired, async (req, res) => {
  try {
    const orgId = req.auth.organizer_id;
    const quote = await loadQuote(req.params.id, orgId);
    if (!quote) return res.status(404).json({ error: 'Quote not found' });

    // Scope check
    if (!(await canAccessRowHierarchical(req, quote.sales_owner_user_id))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Load related data
    const items = await loadLineItems(quote.id);
    const [companyRes, expoRes, personRes, ownerRes] = await Promise.all([
      db.query('SELECT name, country_code FROM companies WHERE id = $1', [quote.company_id]),
      db.query('SELECT name, payment_deadline FROM expos WHERE id = $1', [quote.expo_id]),
      quote.person_id ? db.query('SELECT first_name, last_name, email FROM persons WHERE id = $1', [quote.person_id]) : { rows: [] },
      db.query('SELECT first_name, last_name, email FROM users WHERE id = $1', [quote.sales_owner_user_id]),
    ]);

    const enriched = enrichQuote(quote, items);
    enriched.company = companyRes.rows[0] || null;
    enriched.expo = expoRes.rows[0] || null;
    enriched.person = personRes.rows[0] || null;
    enriched.sales_owner = ownerRes.rows[0] || null;

    res.json(enriched);
  } catch (err) {
    console.error('GET /api/quotes/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/quotes/:id — Update quote (draft only for lines+subject)
router.put('/:id', authRequired, async (req, res) => {
  try {
    const orgId = req.auth.organizer_id;
    const quote = await loadQuote(req.params.id, orgId);
    if (!quote) return res.status(404).json({ error: 'Quote not found' });

    if (!(await canAccessRowHierarchical(req, quote.sales_owner_user_id))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // subject and line_items locked after sent
    const isSentOrLater = quote.status !== 'draft';

    const {
      subject, notes, valid_until, person_id,
      sales_owner_user_id, office_id, expo_id, company_id,
    } = req.body;

    // Build dynamic update
    const sets = [];
    const params = [req.params.id, orgId];
    let idx = 3;

    if (subject !== undefined) {
      if (isSentOrLater) return res.status(400).json({ error: 'Cannot change subject after sending' });
      sets.push(`subject = $${idx}`);
      params.push(subject);
      idx++;
    }
    if (notes !== undefined) {
      sets.push(`notes = $${idx}`);
      params.push(notes || null);
      idx++;
    }
    if (valid_until !== undefined) {
      sets.push(`valid_until = $${idx}`);
      params.push(valid_until || null);
      idx++;
    }
    if (person_id !== undefined) {
      sets.push(`person_id = $${idx}`);
      params.push(person_id || null);
      idx++;
    }
    if (sales_owner_user_id) {
      sets.push(`sales_owner_user_id = $${idx}`);
      params.push(sales_owner_user_id);
      idx++;
    }
    if (office_id) {
      sets.push(`office_id = $${idx}`);
      params.push(office_id);
      idx++;
    }
    if (expo_id && !isSentOrLater) {
      sets.push(`expo_id = $${idx}`);
      params.push(expo_id);
      idx++;
    }
    if (company_id && !isSentOrLater) {
      sets.push(`company_id = $${idx}`);
      params.push(company_id);
      idx++;
    }

    if (sets.length > 0) {
      await db.query(
        `UPDATE quotes SET ${sets.join(', ')} WHERE id = $1 AND organizer_id = $2`,
        params
      );
    }

    const updatedQuote = await loadQuote(req.params.id, orgId);
    const items = await loadLineItems(updatedQuote.id);
    res.json(enrichQuote(updatedQuote, items));
  } catch (err) {
    console.error('PUT /api/quotes/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/quotes/:id — Delete quote (signed = 400, reason required)
router.delete('/:id', authRequired, async (req, res) => {
  try {
    const orgId = req.auth.organizer_id;
    const { role } = getUserContext(req);
    const { userId } = getUserContext(req);

    // Role gate: owner, admin, manager
    if (role !== 'owner' && role !== 'admin' && role !== 'manager') {
      return res.status(403).json({ error: 'Insufficient role' });
    }

    const quote = await loadQuote(req.params.id, orgId);
    if (!quote) return res.status(404).json({ error: 'Quote not found' });

    // Scope check
    if (!(await canAccessRowHierarchical(req, quote.sales_owner_user_id))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Signed quotes cannot be deleted
    if (quote.status === 'signed') {
      return res.status(400).json({ error: 'Signed quotes cannot be deleted' });
    }

    // Reason required
    const reason = (req.body && req.body.reason || '').trim();
    if (!reason) {
      return res.status(400).json({ error: 'Deletion reason is required' });
    }

    // Delete (line items cascade)
    await db.query('DELETE FROM quotes WHERE id = $1 AND organizer_id = $2', [req.params.id, orgId]);

    console.log('[AUDIT] Quote deleted:', JSON.stringify({
      quote_id: req.params.id,
      af_sequence: quote.af_sequence,
      status: quote.status,
      deleted_by_user_id: userId,
      reason,
      timestamp: new Date().toISOString(),
    }));

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/quotes/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// LINE ITEMS (under /api/quotes/:quoteId/items)
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/quotes/:quoteId/items — Add line item (draft only)
router.post('/:quoteId/items', authRequired, async (req, res) => {
  try {
    const orgId = req.auth.organizer_id;
    const quote = await loadQuote(req.params.quoteId, orgId);
    if (!quote) return res.status(404).json({ error: 'Quote not found' });

    if (!(await canAccessRowHierarchical(req, quote.sales_owner_user_id))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (quote.status !== 'draft') {
      return res.status(400).json({ error: 'Cannot add items after sending' });
    }

    const { product_id, description, unit_type, quantity, unit_price, discount_percent, tax_percent, sort_order } = req.body;

    // Snapshot from product if provided
    let desc = description;
    let uType = unit_type;
    let uPrice = unit_price;

    if (product_id) {
      const prodRow = await db.query('SELECT name, unit_type FROM products WHERE id = $1 AND organizer_id = $2', [product_id, orgId]);
      if (prodRow.rows[0]) {
        desc = desc || prodRow.rows[0].name;
        uType = uType || prodRow.rows[0].unit_type;
        if (uPrice == null) {
          const priceRow = await db.query(
            'SELECT unit_price FROM product_prices WHERE product_id = $1 AND office_id = $2',
            [product_id, quote.office_id]
          );
          if (priceRow.rows[0]) uPrice = priceRow.rows[0].unit_price;
        }
      }
    }

    if (!desc) return res.status(400).json({ error: 'description is required' });
    if (!uType || !['m2', 'unit'].includes(uType)) uType = 'unit';
    if (uPrice == null) uPrice = 0;

    const r = await db.query(`
      INSERT INTO quote_line_items (
        quote_id, product_id, description, unit_type, quantity,
        unit_price, discount_percent, tax_percent, sort_order
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [
      quote.id, product_id || null, desc, uType,
      quantity || 1, uPrice,
      discount_percent || 0, tax_percent || 0, sort_order || 0,
    ]);

    res.status(201).json({ ...r.rows[0], line_total: round2(lineTotal(r.rows[0])) });
  } catch (err) {
    console.error('POST /quotes/:id/items error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/quotes/:quoteId/items/:itemId — Update line item (draft only)
router.put('/:quoteId/items/:itemId', authRequired, async (req, res) => {
  try {
    const orgId = req.auth.organizer_id;
    const quote = await loadQuote(req.params.quoteId, orgId);
    if (!quote) return res.status(404).json({ error: 'Quote not found' });

    if (!(await canAccessRowHierarchical(req, quote.sales_owner_user_id))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (quote.status !== 'draft') {
      return res.status(400).json({ error: 'Cannot modify items after sending' });
    }

    const { description, unit_type, quantity, unit_price, discount_percent, tax_percent, sort_order } = req.body;
    if (unit_type && !['m2', 'unit'].includes(unit_type)) {
      return res.status(400).json({ error: 'unit_type must be m2 or unit' });
    }

    const r = await db.query(`
      UPDATE quote_line_items SET
        description = COALESCE($3, description),
        unit_type = COALESCE($4, unit_type),
        quantity = COALESCE($5, quantity),
        unit_price = COALESCE($6, unit_price),
        discount_percent = COALESCE($7, discount_percent),
        tax_percent = COALESCE($8, tax_percent),
        sort_order = COALESCE($9, sort_order)
      WHERE id = $1 AND quote_id = $2
      RETURNING *
    `, [
      req.params.itemId, req.params.quoteId,
      description || null, unit_type || null,
      quantity != null ? quantity : null, unit_price != null ? unit_price : null,
      discount_percent != null ? discount_percent : null, tax_percent != null ? tax_percent : null,
      sort_order != null ? sort_order : null,
    ]);

    if (r.rows.length === 0) return res.status(404).json({ error: 'Line item not found' });
    res.json({ ...r.rows[0], line_total: round2(lineTotal(r.rows[0])) });
  } catch (err) {
    console.error('PUT /quotes/:id/items/:itemId error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/quotes/:quoteId/items/:itemId — Delete line item (draft only)
router.delete('/:quoteId/items/:itemId', authRequired, async (req, res) => {
  try {
    const orgId = req.auth.organizer_id;
    const quote = await loadQuote(req.params.quoteId, orgId);
    if (!quote) return res.status(404).json({ error: 'Quote not found' });

    if (!(await canAccessRowHierarchical(req, quote.sales_owner_user_id))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (quote.status !== 'draft') {
      return res.status(400).json({ error: 'Cannot delete items after sending' });
    }

    const r = await db.query(
      'DELETE FROM quote_line_items WHERE id = $1 AND quote_id = $2 RETURNING id',
      [req.params.itemId, req.params.quoteId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Line item not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /quotes/:id/items/:itemId error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STATUS TRANSITIONS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/quotes/:id/send — draft → sent
router.post('/:id/send', authRequired, async (req, res) => {
  try {
    const orgId = req.auth.organizer_id;
    const quote = await loadQuote(req.params.id, orgId);
    if (!quote) return res.status(404).json({ error: 'Quote not found' });

    if (!(await canAccessRowHierarchical(req, quote.sales_owner_user_id))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (quote.status !== 'draft') {
      return res.status(400).json({ error: `Cannot send: current status is '${quote.status}' (must be draft)` });
    }

    await db.query(
      `UPDATE quotes SET status = 'sent', sent_at = NOW() WHERE id = $1 AND organizer_id = $2`,
      [req.params.id, orgId]
    );

    const updated = await loadQuote(req.params.id, orgId);
    const items = await loadLineItems(updated.id);
    res.json(enrichQuote(updated, items));
  } catch (err) {
    console.error('POST /quotes/:id/send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/quotes/:id/decline — sent → declined
router.post('/:id/decline', authRequired, async (req, res) => {
  try {
    const orgId = req.auth.organizer_id;
    const quote = await loadQuote(req.params.id, orgId);
    if (!quote) return res.status(404).json({ error: 'Quote not found' });

    if (!(await canAccessRowHierarchical(req, quote.sales_owner_user_id))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (quote.status !== 'sent') {
      return res.status(400).json({ error: `Cannot decline: current status is '${quote.status}' (must be sent)` });
    }

    await db.query(
      `UPDATE quotes SET status = 'declined', declined_at = NOW() WHERE id = $1 AND organizer_id = $2`,
      [req.params.id, orgId]
    );

    const updated = await loadQuote(req.params.id, orgId);
    const items = await loadLineItems(updated.id);
    res.json(enrichQuote(updated, items));
  } catch (err) {
    console.error('POST /quotes/:id/decline error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/quotes/:id/sign — sent → signed (TERMINAL)
router.post('/:id/sign', authRequired, async (req, res) => {
  try {
    const orgId = req.auth.organizer_id;
    const quote = await loadQuote(req.params.id, orgId);
    if (!quote) return res.status(404).json({ error: 'Quote not found' });

    if (!(await canAccessRowHierarchical(req, quote.sales_owner_user_id))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (quote.status !== 'sent') {
      return res.status(400).json({ error: `Cannot sign: current status is '${quote.status}' (must be sent)` });
    }

    const { signed_scan_url, signed_at } = req.body;
    if (!signed_scan_url || !signed_scan_url.trim()) {
      return res.status(400).json({ error: 'signed_scan_url is required for signing' });
    }
    if (!signed_at) {
      return res.status(400).json({ error: 'signed_at is required for signing' });
    }

    await db.query(
      `UPDATE quotes SET status = 'signed', signed_scan_url = $3, signed_at = $4
       WHERE id = $1 AND organizer_id = $2`,
      [req.params.id, orgId, signed_scan_url.trim(), signed_at]
    );

    const updated = await loadQuote(req.params.id, orgId);
    const items = await loadLineItems(updated.id);

    // TODO: Sign notification — send internal email to Owner via mailer.sendEmail
    // when LEENA SendGrid pipeline integration is available. For now, log only.
    // Future: convert to full project distribution notification.
    console.log('[QUOTE_SIGNED]', JSON.stringify({
      quote_id: updated.id,
      af_number: afNumber(updated),
      company_id: updated.company_id,
      signed_at: updated.signed_at,
      signed_by_user_id: getUserContext(req).userId,
      timestamp: new Date().toISOString(),
    }));

    res.json(enrichQuote(updated, items));
  } catch (err) {
    console.error('POST /quotes/:id/sign error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
