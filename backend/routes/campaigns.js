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
    const { name, template_id } = req.body;

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

    const result = await db.query(
      `INSERT INTO campaigns (organizer_id, template_id, name, status)
       VALUES ($1, $2, $3, 'draft')
       RETURNING *`,
      [organizerId, template_id, name.trim()]
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
      `SELECT c.*, t.subject as template_subject, t.name as template_name
       FROM campaigns c
       LEFT JOIN email_templates t ON c.template_id = t.id
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
      `SELECT c.*, t.subject as template_subject, t.name as template_name, t.body_html, t.body_text
       FROM campaigns c
       LEFT JOIN email_templates t ON c.template_id = t.id
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
    const { list_id, sender_id, include_risky } = req.body;

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

    let verificationFilter;
    if (campaign.include_risky) {
      verificationFilter = `p.verification_status != 'invalid'`;
    } else {
      verificationFilter = `p.verification_status NOT IN ('invalid', 'risky')`;
    }

    const prospectsQuery = `
      SELECT DISTINCT ON (p.id)
        p.id AS prospect_id,
        p.email,
        p.name,
        p.company,
        p.country,
        p.sector,
        p.meta,
        p.verification_status
      FROM list_members lm
      INNER JOIN prospects p ON p.id = lm.prospect_id
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
       WHERE lm.list_id = $1 
         AND lm.organizer_id = $2
         AND p.verification_status = 'invalid'`,
      [campaign.list_id, organizerId]
    );
    const excludedInvalid = parseInt(invalidCountRes.rows[0].count, 10) || 0;

    let excludedRisky = 0;
    if (!campaign.include_risky) {
      const riskyCountRes = await client.query(
        `SELECT COUNT(*) AS count 
         FROM list_members lm
         INNER JOIN prospects p ON p.id = lm.prospect_id
         WHERE lm.list_id = $1 
           AND lm.organizer_id = $2
           AND p.verification_status = 'risky'`,
        [campaign.list_id, organizerId]
      );
      excludedRisky = parseInt(riskyCountRes.rows[0].count, 10) || 0;
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

      eligibleProspects.forEach((p, idx) => {
        const baseIndex = idx * 6;
        placeholders.push(
          `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6})`
        );
        values.push(
          organizerId,
          campaignId,
          p.prospect_id,
          p.email,
          p.name || null,
          p.meta || null
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
      stats: {
        total_in_list: totalInList,
        excluded_invalid: excludedInvalid,
        excluded_risky: excludedRisky,
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

module.exports = router;
