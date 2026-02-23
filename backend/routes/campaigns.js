const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../db');

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

// POST /api/campaigns
router.post('/', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;
    const { name, template_id, list_id, sender_id } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Campaign name is required' });
    }

    if (!template_id) {
      return res.status(400).json({ error: 'Template is required' });
    }

    const templateCheck = await db.query(
      `SELECT id FROM email_templates WHERE id = $1 AND organizer_id = $2`,
      [template_id, organizerId]
    );

    if (templateCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Template not found or access denied' });
    }

    if (list_id) {
      const listCheck = await db.query(
        `SELECT id FROM lists WHERE id = $1 AND organizer_id = $2`,
        [list_id, organizerId]
      );
      if (listCheck.rows.length === 0) {
        return res.status(400).json({ error: 'List not found' });
      }
    }

    if (sender_id) {
      const senderCheck = await db.query(
        `SELECT id FROM sender_identities WHERE id = $1 AND organizer_id = $2`,
        [sender_id, organizerId]
      );
      if (senderCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Sender not found' });
      }
    }

    const result = await db.query(
      `INSERT INTO campaigns (organizer_id, template_id, list_id, sender_id, name, status)
       VALUES ($1, $2, $3, $4, $5, 'draft')
       RETURNING *`,
      [organizerId, template_id, list_id || null, sender_id || null, name.trim()]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Create campaign error:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/campaigns
router.get('/', authRequired, async (req, res) => {
  try {
    const organizerId = req.auth.organizer_id;

    const result = await db.query(
      `SELECT c.*, 
              t.subject as template_subject, 
              t.name as template_name,
              l.name as list_name,
              s.from_email as sender_email,
              s.from_name as sender_name
       FROM campaigns c
       LEFT JOIN email_templates t ON c.template_id = t.id
       LEFT JOIN lists l ON c.list_id = l.id
       LEFT JOIN sender_identities s ON c.sender_id = s.id
       WHERE c.organizer_id = $1
       ORDER BY c.created_at DESC`,
      [organizerId]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/campaigns/:id
router.get('/:id', authRequired, async (req, res) => {
  try {
    const campaignId = req.params.id;
    const organizerId = req.auth.organizer_id;

    const result = await db.query(
      `SELECT c.*,
              t.subject as template_subject,
              t.name as template_name,
              t.body_html,
              t.body_text,
              l.name as list_name,
              s.from_email as sender_email,
              s.from_name as sender_name
       FROM campaigns c
       LEFT JOIN email_templates t ON c.template_id = t.id
       LEFT JOIN lists l ON c.list_id = l.id
       LEFT JOIN sender_identities s ON c.sender_id = s.id
       WHERE c.id = $1 AND c.organizer_id = $2`,
      [campaignId, organizerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/campaigns/:id
router.delete('/:id', authRequired, async (req, res) => {
  try {
    const campaignId = req.params.id;
    const organizerId = req.auth.organizer_id;

    const campRes = await db.query(
      `SELECT * FROM campaigns WHERE id = $1 AND organizer_id = $2`,
      [campaignId, organizerId]
    );

    if (campRes.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const campaign = campRes.rows[0];

    if (campaign.status === 'sending') {
      return res.status(400).json({ 
        error: "Cannot delete campaign while it is sending" 
      });
    }

    await db.query(
      `DELETE FROM campaign_recipients WHERE campaign_id = $1 AND organizer_id = $2`,
      [campaignId, organizerId]
    );

    await db.query(
      `DELETE FROM campaigns WHERE id = $1 AND organizer_id = $2`,
      [campaignId, organizerId]
    );

    return res.json({ success: true, deleted: campaignId });
  } catch (err) {
    console.error("Delete campaign error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/campaigns/:id
router.patch('/:id', authRequired, async (req, res) => {
  try {
    const campaignId = req.params.id;
    const organizerId = req.auth.organizer_id;
    const { list_id, sender_id, include_risky, verification_mode } = req.body;

    const campRes = await db.query(
      `SELECT * FROM campaigns WHERE id = $1 AND organizer_id = $2`,
      [campaignId, organizerId]
    );

    if (campRes.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const campaign = campRes.rows[0];

    if (campaign.status !== 'draft') {
      return res.status(400).json({
        error: `Cannot update campaign: status is '${campaign.status}', expected 'draft'`
      });
    }

    const updates = [];
    const values = [];
    let idx = 1;

    if (list_id !== undefined) {
      if (list_id) {
        const listCheck = await db.query(
          `SELECT id FROM lists WHERE id = $1 AND organizer_id = $2`,
          [list_id, organizerId]
        );
        if (listCheck.rows.length === 0) {
          return res.status(400).json({ error: "List not found or access denied" });
        }
      }
      updates.push(`list_id = $${idx++}`);
      values.push(list_id || null);
    }

    if (sender_id !== undefined) {
      if (sender_id) {
        const senderCheck = await db.query(
          `SELECT id FROM sender_identities WHERE id = $1 AND organizer_id = $2 AND is_active = true`,
          [sender_id, organizerId]
        );
        if (senderCheck.rows.length === 0) {
          return res.status(400).json({ error: "Sender not found, inactive, or access denied" });
        }
      }
      updates.push(`sender_id = $${idx++}`);
      values.push(sender_id || null);
    }

    if (include_risky !== undefined) {
      updates.push(`include_risky = $${idx++}`);
      values.push(Boolean(include_risky));
    }

    if (verification_mode !== undefined) {
      const allowedModes = ['exclude_invalid', 'verified_only'];
      if (!allowedModes.includes(verification_mode)) {
        return res.status(400).json({ error: `Invalid verification_mode. Must be one of: ${allowedModes.join(', ')}` });
      }
      updates.push(`verification_mode = $${idx++}`);
      values.push(verification_mode);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    values.push(campaignId);
    values.push(organizerId);

    const updateQuery = `
      UPDATE campaigns
      SET ${updates.join(', ')}
      WHERE id = $${idx++} AND organizer_id = $${idx}
      RETURNING *
    `;

    const result = await db.query(updateQuery, values);

    return res.json(result.rows[0]);
  } catch (err) {
    console.error("Patch campaign error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/resolve
router.post('/:id/resolve', authRequired, async (req, res) => {
  const client = await db.connect();

  try {
    const campaignId = req.params.id;
    const organizerId = req.auth.organizer_id;

    await client.query('BEGIN');

    const campRes = await client.query(
      `SELECT * FROM campaigns WHERE id = $1 AND organizer_id = $2`,
      [campaignId, organizerId]
    );

    if (campRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Campaign not found" });
    }

    const campaign = campRes.rows[0];

    if (campaign.status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Cannot resolve campaign: status is '${campaign.status}', expected 'draft'`
      });
    }

    if (!campaign.list_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: "Cannot resolve campaign: no list assigned"
      });
    }

    if (!campaign.sender_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: "Cannot resolve campaign: no sender identity assigned"
      });
    }

    const senderRes = await client.query(
      `SELECT id FROM sender_identities WHERE id = $1 AND organizer_id = $2 AND is_active = true`,
      [campaign.sender_id, organizerId]
    );

    if (senderRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: "Cannot resolve campaign: sender identity not found or inactive"
      });
    }

    // Accept verification_mode from request body (overrides campaign default)
    const bodyMode = req.body && req.body.verification_mode;
    const allowedModes = ['exclude_invalid', 'verified_only'];
    const verificationMode = allowedModes.includes(bodyMode) ? bodyMode : (campaign.verification_mode || 'exclude_invalid');

    // Persist verification_mode to campaign if provided in body
    if (bodyMode && allowedModes.includes(bodyMode)) {
      await client.query(
        `UPDATE campaigns SET verification_mode = $1 WHERE id = $2 AND organizer_id = $3`,
        [verificationMode, campaignId, organizerId]
      );
    }

    // --- Phase 3: Canonical resolve (persons + affiliations preferred, prospects fallback) ---
    // Verification status: prefer persons.verification_status (canonical), fallback to prospects
    let verificationFilter;
    if (verificationMode === 'verified_only') {
      // Only send to valid or catchall emails
      verificationFilter = `COALESCE(pn.verification_status, p.verification_status, 'unknown') IN ('valid', 'catchall')`;
    } else if (campaign.include_risky) {
      verificationFilter = `COALESCE(pn.verification_status, p.verification_status, 'unknown') != 'invalid'`;
    } else {
      verificationFilter = `COALESCE(pn.verification_status, p.verification_status, 'unknown') NOT IN ('invalid', 'risky')`;
    }

    const prospectsQuery = `
      SELECT DISTINCT ON (p.id)
        p.id AS prospect_id,
        p.email,
        COALESCE(CONCAT_WS(' ', pn.first_name, pn.last_name), p.name) AS name,
        COALESCE(aff.company_name, p.company) AS company,
        COALESCE(aff.country_code, p.country) AS country,
        COALESCE(aff.position, p.sector) AS sector,
        p.meta,
        COALESCE(pn.verification_status, p.verification_status, 'unknown') AS verification_status,
        pn.id AS person_id,
        pn.first_name,
        pn.last_name,
        aff.company_name AS affiliation_company,
        aff.position AS affiliation_position,
        aff.city AS affiliation_city,
        aff.website AS affiliation_website,
        aff.phone AS affiliation_phone
      FROM list_members lm
      INNER JOIN prospects p ON p.id = lm.prospect_id
      LEFT JOIN persons pn ON LOWER(pn.email) = LOWER(p.email) AND pn.organizer_id = $2
      LEFT JOIN LATERAL (
        SELECT company_name, position, country_code, city, website, phone
        FROM affiliations
        WHERE person_id = pn.id AND organizer_id = $2
        ORDER BY created_at DESC LIMIT 1
      ) aff ON pn.id IS NOT NULL
      WHERE lm.list_id = $1
        AND lm.organizer_id = $2
        AND p.organizer_id = $2
        AND p.email IS NOT NULL
        AND TRIM(p.email) != ''
        AND ${verificationFilter}
        AND NOT EXISTS (
          SELECT 1 FROM unsubscribes u
          WHERE u.organizer_id = $2
            AND LOWER(u.email) = LOWER(p.email)
        )
        AND NOT EXISTS (
          SELECT 1 FROM campaign_recipients cr
          WHERE cr.campaign_id = $3
            AND cr.prospect_id = p.id
        )
      ORDER BY p.id, p.created_at ASC
    `;

    const prospectsRes = await client.query(prospectsQuery, [
      campaign.list_id,
      organizerId,
      campaignId
    ]);

    const eligibleProspects = prospectsRes.rows;

    const totalInListRes = await client.query(
      `SELECT COUNT(*) AS count FROM list_members
       WHERE list_id = $1 AND organizer_id = $2`,
      [campaign.list_id, organizerId]
    );
    const totalInList = parseInt(totalInListRes.rows[0].count, 10) || 0;

    const invalidCountRes = await client.query(
      `SELECT COUNT(*) AS count
       FROM list_members lm
       INNER JOIN prospects p ON p.id = lm.prospect_id
       LEFT JOIN persons pn ON LOWER(pn.email) = LOWER(p.email) AND pn.organizer_id = $2
       WHERE lm.list_id = $1
         AND lm.organizer_id = $2
         AND COALESCE(pn.verification_status, p.verification_status, 'unknown') = 'invalid'`,
      [campaign.list_id, organizerId]
    );
    const excludedInvalid = parseInt(invalidCountRes.rows[0].count, 10) || 0;

    let excludedRisky = 0;
    if (verificationMode !== 'verified_only' && !campaign.include_risky) {
      const riskyCountRes = await client.query(
        `SELECT COUNT(*) AS count
         FROM list_members lm
         INNER JOIN prospects p ON p.id = lm.prospect_id
         LEFT JOIN persons pn ON LOWER(pn.email) = LOWER(p.email) AND pn.organizer_id = $2
         WHERE lm.list_id = $1
           AND lm.organizer_id = $2
           AND COALESCE(pn.verification_status, p.verification_status, 'unknown') = 'risky'`,
        [campaign.list_id, organizerId]
      );
      excludedRisky = parseInt(riskyCountRes.rows[0].count, 10) || 0;
    }

    let excludedUnverified = 0;
    if (verificationMode === 'verified_only') {
      const unverifiedCountRes = await client.query(
        `SELECT COUNT(*) AS count
         FROM list_members lm
         INNER JOIN prospects p ON p.id = lm.prospect_id
         LEFT JOIN persons pn ON LOWER(pn.email) = LOWER(p.email) AND pn.organizer_id = $2
         WHERE lm.list_id = $1
           AND lm.organizer_id = $2
           AND COALESCE(pn.verification_status, p.verification_status, 'unknown') NOT IN ('valid', 'catchall', 'invalid')`,
        [campaign.list_id, organizerId]
      );
      excludedUnverified = parseInt(unverifiedCountRes.rows[0].count, 10) || 0;
    }

    const unsubCountRes = await client.query(
      `SELECT COUNT(*) AS count
       FROM list_members lm
       INNER JOIN prospects p ON p.id = lm.prospect_id
       WHERE lm.list_id = $1
         AND lm.organizer_id = $2
         AND EXISTS (
           SELECT 1 FROM unsubscribes u
           WHERE u.organizer_id = $2
             AND LOWER(u.email) = LOWER(p.email)
         )`,
      [campaign.list_id, organizerId]
    );
    const excludedUnsubscribed = parseInt(unsubCountRes.rows[0].count, 10) || 0;

    let insertedCount = 0;

    if (eligibleProspects.length > 0) {
      const values = [];
      const placeholders = [];

      eligibleProspects.forEach((ep, idx) => {
        const baseIndex = idx * 6;
        placeholders.push(
          `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6})`
        );

        // Build enriched meta from canonical + legacy data
        const legacyMeta = (typeof ep.meta === "string" ? JSON.parse(ep.meta || "{}") : ep.meta) || {};
        const enrichedMeta = {
          ...legacyMeta,
          company: ep.company,
          country: ep.country,
          position: ep.sector,
          company_name: ep.company,
          first_name: ep.first_name || null,
          last_name: ep.last_name || null,
          city: ep.affiliation_city || legacyMeta.city || null,
          website: ep.affiliation_website || legacyMeta.website || null,
          phone: ep.affiliation_phone || legacyMeta.phone || null,
          person_id: ep.person_id || null
        };

        values.push(
          organizerId,
          campaignId,
          ep.prospect_id,
          ep.email,
          ep.name || null,
          JSON.stringify(enrichedMeta)
        );
      });

      const insertQuery = `
        INSERT INTO campaign_recipients
          (organizer_id, campaign_id, prospect_id, email, name, meta)
        VALUES ${placeholders.join(', ')}
        RETURNING id
      `;

      const insertRes = await client.query(insertQuery, values);
      insertedCount = insertRes.rows.length;
    }

    const updateRes = await client.query(
      `UPDATE campaigns
       SET status = 'ready',
           recipient_count = $3
       WHERE id = $1 
         AND organizer_id = $2
         AND status = 'draft'
       RETURNING *`,
      [campaignId, organizerId, insertedCount]
    );

    if (updateRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(500).json({
        error: "Failed to update campaign status"
      });
    }

    const updatedCampaign = updateRes.rows[0];

    await client.query('COMMIT');

    return res.json({
      success: true,
      campaign: updatedCampaign,
      recipient_count: insertedCount,
      verification_mode: verificationMode,
      stats: {
        total_in_list: totalInList,
        excluded_invalid: excludedInvalid,
        excluded_risky: excludedRisky,
        excluded_unverified: excludedUnverified,
        excluded_unsubscribed: excludedUnsubscribed,
        eligible: eligibleProspects.length,
        inserted: insertedCount
      }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Campaign resolve error:", err);
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/campaigns/:id/start - NEW ENDPOINT
router.post('/:id/start', authRequired, async (req, res) => {
  try {
    const campaignId = req.params.id;
    const organizerId = req.auth.organizer_id;

    const campRes = await db.query(
      `SELECT * FROM campaigns WHERE id = $1 AND organizer_id = $2`,
      [campaignId, organizerId]
    );

    if (campRes.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const campaign = campRes.rows[0];

    // Allow start from 'ready' or 'scheduled' status
    if (campaign.status !== 'ready' && campaign.status !== 'scheduled') {
      return res.status(400).json({
        error: `Cannot start campaign: status is '${campaign.status}', expected 'ready' or 'scheduled'`
      });
    }

    // Check if there are recipients
    const recipientCount = await db.query(
      `SELECT COUNT(*) as count FROM campaign_recipients WHERE campaign_id = $1`,
      [campaignId]
    );

    if (parseInt(recipientCount.rows[0].count) === 0) {
      return res.status(400).json({
        error: "Cannot start campaign: no recipients found. Please resolve the campaign first."
      });
    }

    const updateRes = await db.query(
      `UPDATE campaigns
       SET status = 'sending', started_at = NOW(), scheduled_at = NULL
       WHERE id = $1 AND organizer_id = $2 AND status IN ('ready', 'scheduled')
       RETURNING *`,
      [campaignId, organizerId]
    );

    if (updateRes.rows.length === 0) {
      return res.status(400).json({ error: "Failed to start campaign" });
    }

    return res.json({
      success: true,
      campaign: updateRes.rows[0]
    });

  } catch (err) {
    console.error("Campaign start error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/pause
router.post('/:id/pause', authRequired, async (req, res) => {
  try {
    const campaignId = req.params.id;
    const organizerId = req.auth.organizer_id;

    const campRes = await db.query(
      `SELECT * FROM campaigns WHERE id = $1 AND organizer_id = $2`,
      [campaignId, organizerId]
    );

    if (campRes.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const campaign = campRes.rows[0];

    if (campaign.status !== 'sending') {
      return res.status(400).json({
        error: `Cannot pause campaign: status is '${campaign.status}', expected 'sending'`
      });
    }

    const updateRes = await db.query(
      `UPDATE campaigns 
       SET status = 'paused' 
       WHERE id = $1 AND organizer_id = $2 AND status = 'sending'
       RETURNING *`,
      [campaignId, organizerId]
    );

    if (updateRes.rows.length === 0) {
      return res.status(400).json({ error: "Failed to pause campaign" });
    }

    return res.json({
      success: true,
      campaign: updateRes.rows[0]
    });

  } catch (err) {
    console.error("Campaign pause error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/resume
router.post('/:id/resume', authRequired, async (req, res) => {
  try {
    const campaignId = req.params.id;
    const organizerId = req.auth.organizer_id;

    const campRes = await db.query(
      `SELECT * FROM campaigns WHERE id = $1 AND organizer_id = $2`,
      [campaignId, organizerId]
    );

    if (campRes.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const campaign = campRes.rows[0];

    if (campaign.status !== 'paused') {
      return res.status(400).json({
        error: `Cannot resume campaign: status is '${campaign.status}', expected 'paused'`
      });
    }

    const updateRes = await db.query(
      `UPDATE campaigns 
       SET status = 'sending' 
       WHERE id = $1 AND organizer_id = $2 AND status = 'paused'
       RETURNING *`,
      [campaignId, organizerId]
    );

    if (updateRes.rows.length === 0) {
      return res.status(400).json({ error: "Failed to resume campaign" });
    }

    return res.json({
      success: true,
      campaign: updateRes.rows[0]
    });

  } catch (err) {
    console.error("Campaign resume error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/schedule
router.post('/:id/schedule', authRequired, async (req, res) => {
  try {
    const campaignId = req.params.id;
    const organizerId = req.auth.organizer_id;
    const { scheduled_at } = req.body;

    if (!scheduled_at) {
      return res.status(400).json({ error: "scheduled_at is required (ISO 8601 format)" });
    }

    const scheduleDate = new Date(scheduled_at);
    if (isNaN(scheduleDate.getTime())) {
      return res.status(400).json({ error: "Invalid date format. Use ISO 8601 (e.g. 2026-03-01T10:00:00Z)" });
    }

    if (scheduleDate <= new Date()) {
      return res.status(400).json({ error: "scheduled_at must be in the future" });
    }

    const campRes = await db.query(
      `SELECT * FROM campaigns WHERE id = $1 AND organizer_id = $2`,
      [campaignId, organizerId]
    );

    if (campRes.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const campaign = campRes.rows[0];

    if (campaign.status !== 'ready') {
      return res.status(400).json({
        error: `Cannot schedule campaign: status is '${campaign.status}', expected 'ready'`
      });
    }

    const updateRes = await db.query(
      `UPDATE campaigns
       SET status = 'scheduled', scheduled_at = $3
       WHERE id = $1 AND organizer_id = $2 AND status = 'ready'
       RETURNING *`,
      [campaignId, organizerId, scheduleDate.toISOString()]
    );

    if (updateRes.rows.length === 0) {
      return res.status(400).json({ error: "Failed to schedule campaign" });
    }

    return res.json({
      success: true,
      campaign: updateRes.rows[0]
    });

  } catch (err) {
    console.error("Campaign schedule error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// NEW ENDPOINTS ADDED BELOW - V2
// ============================================================

// GET /api/campaigns/:id/stats - Campaign statistics
router.get('/:id/stats', authRequired, async (req, res) => {
  try {
    const campaignId = req.params.id;
    const organizerId = req.auth.organizer_id;

    // Verify campaign exists and belongs to organizer
    const campRes = await db.query(
      `SELECT id, name, status, recipient_count, started_at, completed_at
       FROM campaigns 
       WHERE id = $1 AND organizer_id = $2`,
      [campaignId, organizerId]
    );

    if (campRes.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    // Get recipient status counts
    const statsRes = await db.query(
      `SELECT 
         COUNT(*) FILTER (WHERE status = 'pending') as pending,
         COUNT(*) FILTER (WHERE status = 'sent') as sent,
         COUNT(*) FILTER (WHERE status = 'failed') as failed,
         COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
         COUNT(*) FILTER (WHERE status = 'opened') as opened,
         COUNT(*) FILTER (WHERE status = 'clicked') as clicked,
         COUNT(*) FILTER (WHERE status = 'bounced') as bounced,
         COUNT(*) as total
       FROM campaign_recipients
       WHERE campaign_id = $1 AND organizer_id = $2`,
      [campaignId, organizerId]
    );

    const stats = statsRes.rows[0];

    return res.json({
      campaign: campRes.rows[0],
      stats: {
        total: parseInt(stats.total) || 0,
        pending: parseInt(stats.pending) || 0,
        sent: parseInt(stats.sent) || 0,
        failed: parseInt(stats.failed) || 0,
        delivered: parseInt(stats.delivered) || 0,
        opened: parseInt(stats.opened) || 0,
        clicked: parseInt(stats.clicked) || 0,
        bounced: parseInt(stats.bounced) || 0
      }
    });

  } catch (err) {
    console.error("Campaign stats error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/:id/analytics - Campaign analytics from campaign_events
router.get('/:id/analytics', authRequired, async (req, res) => {
  try {
    const campaignId = req.params.id;
    const organizerId = req.auth.organizer_id;

    // Verify campaign exists and belongs to organizer
    const campRes = await db.query(
      `SELECT id, name, status, recipient_count, started_at, completed_at
       FROM campaigns
       WHERE id = $1 AND organizer_id = $2`,
      [campaignId, organizerId]
    );

    if (campRes.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const campaign = campRes.rows[0];

    // 1. Summary: event_type counts (campaign_events with campaign_recipients fallback)
    const summaryRes = await db.query(
      `SELECT event_type, COUNT(*) as count
       FROM campaign_events
       WHERE campaign_id = $1 AND organizer_id = $2
       GROUP BY event_type`,
      [campaignId, organizerId]
    );

    const counts = {};
    summaryRes.rows.forEach(r => { counts[r.event_type] = parseInt(r.count, 10); });

    let sent = counts.sent || 0;
    let delivered = counts.delivered || 0;
    let opens = counts.open || 0;
    let clicks = counts.click || 0;
    let bounces = counts.bounce || 0;
    let spamReports = counts.spam_report || 0;
    let unsubscribes = counts.unsubscribe || 0;
    let replies = counts.reply || 0;
    let dropped = counts.dropped || 0;
    let deferred = counts.deferred || 0;
    let dataSource = 'campaign_events';

    // Hybrid: campaign_events may undercount 'sent' (worker didn't record before fix).
    // Always cross-check with campaign_recipients and use the higher number.
    const sentFallback = await db.query(
      `SELECT COUNT(*) as count FROM campaign_recipients
       WHERE campaign_id = $1 AND organizer_id = $2
         AND status IN ('sent','delivered','opened','clicked','bounced')`,
      [campaignId, organizerId]
    );
    const recipientSent = parseInt(sentFallback.rows[0].count) || 0;
    if (recipientSent > sent) {
      sent = recipientSent;
    }

    // Fallback: if campaign_events is empty, aggregate from campaign_recipients
    if (summaryRes.rows.length === 0) {
      const fallbackRes = await db.query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('sent','delivered','opened','clicked','bounced')) as sent,
           COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
           COUNT(*) FILTER (WHERE status = 'opened') as opened,
           COUNT(*) FILTER (WHERE status = 'clicked') as clicked,
           COUNT(*) FILTER (WHERE status = 'bounced') as bounced,
           COUNT(*) FILTER (WHERE opened_at IS NOT NULL) as opened_any,
           COUNT(*) FILTER (WHERE clicked_at IS NOT NULL) as clicked_any,
           COUNT(*) FILTER (WHERE bounced_at IS NOT NULL) as bounced_any,
           COUNT(*) FILTER (WHERE delivered_at IS NOT NULL) as delivered_any
         FROM campaign_recipients
         WHERE campaign_id = $1 AND organizer_id = $2`,
        [campaignId, organizerId]
      );
      const fb = fallbackRes.rows[0];
      sent = parseInt(fb.sent) || 0;
      // Use the broader timestamp-based counts for engagement metrics
      delivered = Math.max(parseInt(fb.delivered) || 0, parseInt(fb.delivered_any) || 0);
      opens = Math.max(parseInt(fb.opened) || 0, parseInt(fb.opened_any) || 0);
      clicks = Math.max(parseInt(fb.clicked) || 0, parseInt(fb.clicked_any) || 0);
      bounces = Math.max(parseInt(fb.bounced) || 0, parseInt(fb.bounced_any) || 0);
      dataSource = 'campaign_recipients';
    }

    const base = sent || 1; // avoid division by zero
    const summary = {
      sent,
      delivered,
      opens,
      clicks,
      bounces,
      spam_reports: spamReports,
      unsubscribes,
      replies,
      dropped,
      deferred,
      delivery_rate: +(delivered / base * 100).toFixed(2),
      open_rate: +(opens / base * 100).toFixed(2),
      click_rate: +(opens > 0 ? clicks / opens * 100 : 0).toFixed(2),
      bounce_rate: +(bounces / base * 100).toFixed(2),
      spam_rate: +(spamReports / base * 100).toFixed(2),
      unsubscribe_rate: +(unsubscribes / base * 100).toFixed(2),
      data_source: dataSource
    };

    // 2. Timeline: bucketized by hour or day
    const bucket = req.query.bucket === 'hour' ? 'hour' : 'day';
    let timelineRes;

    if (dataSource === 'campaign_events') {
      timelineRes = await db.query(
        `SELECT
           date_trunc($3, occurred_at) as period,
           event_type,
           COUNT(*) as count
         FROM campaign_events
         WHERE campaign_id = $1 AND organizer_id = $2
         GROUP BY period, event_type
         ORDER BY period ASC`,
        [campaignId, organizerId, bucket]
      );
    } else {
      // Fallback: build timeline from campaign_recipients timestamps
      timelineRes = await db.query(
        `SELECT period, event_type, COUNT(*) as count FROM (
           SELECT date_trunc($3, sent_at) as period, 'sent' as event_type FROM campaign_recipients WHERE campaign_id = $1 AND organizer_id = $2 AND sent_at IS NOT NULL
           UNION ALL
           SELECT date_trunc($3, delivered_at), 'delivered' FROM campaign_recipients WHERE campaign_id = $1 AND organizer_id = $2 AND delivered_at IS NOT NULL
           UNION ALL
           SELECT date_trunc($3, opened_at), 'open' FROM campaign_recipients WHERE campaign_id = $1 AND organizer_id = $2 AND opened_at IS NOT NULL
           UNION ALL
           SELECT date_trunc($3, clicked_at), 'click' FROM campaign_recipients WHERE campaign_id = $1 AND organizer_id = $2 AND clicked_at IS NOT NULL
           UNION ALL
           SELECT date_trunc($3, bounced_at), 'bounce' FROM campaign_recipients WHERE campaign_id = $1 AND organizer_id = $2 AND bounced_at IS NOT NULL
         ) sub
         GROUP BY period, event_type
         ORDER BY period ASC`,
        [campaignId, organizerId, bucket]
      );
    }

    // Pivot timeline: group by period, with event counts
    const timelineMap = new Map();
    timelineRes.rows.forEach(r => {
      const key = r.period.toISOString();
      if (!timelineMap.has(key)) {
        timelineMap.set(key, { period: key });
      }
      timelineMap.get(key)[r.event_type] = parseInt(r.count, 10);
    });
    const timeline = Array.from(timelineMap.values());

    // 3. Top Links: most clicked URLs
    const topLinksRes = await db.query(
      `SELECT url, COUNT(*) as clicks
       FROM campaign_events
       WHERE campaign_id = $1 AND organizer_id = $2
         AND event_type = 'click' AND url IS NOT NULL
       GROUP BY url
       ORDER BY clicks DESC
       LIMIT 10`,
      [campaignId, organizerId]
    );

    const topLinks = topLinksRes.rows.map(r => ({
      url: r.url,
      clicks: parseInt(r.clicks, 10)
    }));

    // 4. Bounce Breakdown: hard vs soft vs unknown
    let bounceRes;
    if (dataSource === 'campaign_events') {
      bounceRes = await db.query(
        `SELECT reason, COUNT(*) as count
         FROM campaign_events
         WHERE campaign_id = $1 AND organizer_id = $2
           AND event_type = 'bounce'
         GROUP BY reason`,
        [campaignId, organizerId]
      );
    } else {
      // Fallback: use last_error from campaign_recipients
      bounceRes = await db.query(
        `SELECT last_error as reason, COUNT(*) as count
         FROM campaign_recipients
         WHERE campaign_id = $1 AND organizer_id = $2
           AND bounced_at IS NOT NULL
         GROUP BY last_error`,
        [campaignId, organizerId]
      );
    }

    let hardBounces = 0;
    let softBounces = 0;
    let unknownBounces = 0;
    bounceRes.rows.forEach(r => {
      const count = parseInt(r.count, 10);
      const reason = (r.reason || '').toLowerCase();
      if (reason.includes('550') || reason.includes('invalid') || reason.includes('not exist') || reason.includes('hard')) {
        hardBounces += count;
      } else if (reason.includes('temp') || reason.includes('full') || reason.includes('soft') || reason.includes('defer')) {
        softBounces += count;
      } else {
        unknownBounces += count;
      }
    });

    return res.json({
      campaign,
      summary,
      timeline,
      top_links: topLinks,
      bounce_breakdown: {
        hard: hardBounces,
        soft: softBounces,
        unknown: unknownBounces,
        total: hardBounces + softBounces + unknownBounces
      }
    });

  } catch (err) {
    console.error("Campaign analytics error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/:id/recipients - Campaign recipients list
router.get('/:id/recipients', authRequired, async (req, res) => {
  try {
    const campaignId = req.params.id;
    const organizerId = req.auth.organizer_id;
    const { status, limit = 100, offset = 0 } = req.query;

    // Verify campaign exists and belongs to organizer
    const campRes = await db.query(
      `SELECT id FROM campaigns WHERE id = $1 AND organizer_id = $2`,
      [campaignId, organizerId]
    );

    if (campRes.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    // Build query with optional status filter
    let query = `
      SELECT id, email, name, status, meta, sent_at, last_error, created_at
      FROM campaign_recipients
      WHERE campaign_id = $1 AND organizer_id = $2
    `;
    const params = [campaignId, organizerId];

    if (status) {
      query += ` AND status = $3`;
      params.push(status);
    }

    query += ` ORDER BY created_at ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const recipientsRes = await db.query(query, params);

    // Get total count
    let countQuery = `
      SELECT COUNT(*) as total
      FROM campaign_recipients
      WHERE campaign_id = $1 AND organizer_id = $2
    `;
    const countParams = [campaignId, organizerId];

    if (status) {
      countQuery += ` AND status = $3`;
      countParams.push(status);
    }

    const countRes = await db.query(countQuery, countParams);

    return res.json({
      recipients: recipientsRes.rows,
      pagination: {
        total: parseInt(countRes.rows[0].total) || 0,
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });

  } catch (err) {
    console.error("Campaign recipients error:", err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
