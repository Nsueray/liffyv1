const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../db');
const campaigns = require('../models/campaigns');

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

// ============================================================
// AUTH MIDDLEWARE (for new endpoints only)
// ============================================================

/**
 * JWT authentication middleware
 * Attaches req.auth with user_id, organizer_id, role
 */
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

// ============================================================
// EXISTING ENDPOINTS - DO NOT MODIFY
// ============================================================

router.post('/api/campaigns', async (req, res) => {
  try {
    const { organizer_id, template_id, name, scheduled_at } = req.body;
    if (!organizer_id || !template_id || !name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const campaign = await campaigns.createCampaign(
      organizer_id, template_id, name, scheduled_at
    );
    res.json(campaign);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/api/campaigns', async (req, res) => {
  try {
    const { organizer_id } = req.query;
    if (!organizer_id) {
      return res.status(400).json({ error: 'organizer_id is required' });
    }
    const campaignList = await campaigns.getCampaignsByOrganizer(organizer_id);
    res.json(campaignList);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/api/campaigns/:id', async (req, res) => {
  try {
    const campaign = await campaigns.getCampaignById(req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    res.json(campaign);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/api/campaigns/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }
    const campaign = await campaigns.updateCampaignStatus(req.params.id, status);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    res.json(campaign);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/api/campaigns/:id', async (req, res) => {
  try {
    const campaign = await campaigns.deleteCampaign(req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    res.json({ message: 'Campaign deleted successfully', campaign });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// NEW ENDPOINT: POST /api/campaigns/:id/resolve
// ============================================================

/**
 * POST /api/campaigns/:id/resolve
 * 
 * Transitions campaign from DRAFT → READY by resolving recipients.
 * 
 * This is a deterministic, one-time operation that:
 * 1. Loads prospects from the campaign's list snapshot
 * 2. Applies filtering (invalid, risky, unsubscribed)
 * 3. Deduplicates by prospect_id (in SELECT, before INSERT)
 * 4. Excludes prospects already in campaign_recipients
 * 5. Inserts resolved recipients into campaign_recipients
 * 6. Sets campaign status to 'ready' with final recipient_count
 * 
 * After READY, the recipient set is IMMUTABLE.
 * 
 * Requires: JWT auth
 * 
 * Returns:
 * - 200: { success: true, campaign, recipient_count, stats }
 * - 400: Validation error (missing list_id, sender_id, wrong status)
 * - 401: Authentication error
 * - 404: Campaign not found
 * - 500: Server error
 */
router.post('/api/campaigns/:id/resolve', authRequired, async (req, res) => {
  const client = await db.connect();

  try {
    const campaignId = req.params.id;
    const organizerId = req.auth.organizer_id;

    // Start transaction
    await client.query('BEGIN');

    // --------------------------------------------------------
    // 1. Load and validate campaign
    // --------------------------------------------------------
    const campRes = await client.query(
      `SELECT * FROM campaigns 
       WHERE id = $1 AND organizer_id = $2
       FOR UPDATE`,
      [campaignId, organizerId]
    );

    if (campRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Campaign not found" });
    }

    const campaign = campRes.rows[0];

    // Validate status
    if (campaign.status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: `Cannot resolve campaign: status is '${campaign.status}', expected 'draft'` 
      });
    }

    // Validate list_id
    if (!campaign.list_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: "Cannot resolve campaign: list_id is not set" 
      });
    }

    // Validate sender_id
    if (!campaign.sender_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: "Cannot resolve campaign: sender_id is not set" 
      });
    }

    // --------------------------------------------------------
    // 2. Verify list exists and belongs to organizer
    // --------------------------------------------------------
    const listRes = await client.query(
      `SELECT id FROM lists 
       WHERE id = $1 AND organizer_id = $2`,
      [campaign.list_id, organizerId]
    );

    if (listRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: "Cannot resolve campaign: list not found or access denied" 
      });
    }

    // --------------------------------------------------------
    // 3. Verify sender exists and belongs to organizer
    // --------------------------------------------------------
    const senderRes = await client.query(
      `SELECT id FROM sender_identities 
       WHERE id = $1 AND organizer_id = $2 AND is_active = true`,
      [campaign.sender_id, organizerId]
    );

    if (senderRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: "Cannot resolve campaign: sender identity not found or inactive" 
      });
    }

    // --------------------------------------------------------
    // 4. Load prospects from list snapshot with filtering
    // --------------------------------------------------------
    // Build verification status filter
    let verificationFilter;
    if (campaign.include_risky) {
      // Include valid, risky, unknown - exclude only invalid
      verificationFilter = `p.verification_status != 'invalid'`;
    } else {
      // Include only valid and unknown - exclude invalid and risky
      verificationFilter = `p.verification_status NOT IN ('invalid', 'risky')`;
    }

    // Load eligible prospects from the list
    // - Joined via list_members (the static snapshot)
    // - Filtered by verification status
    // - Filtered against unsubscribes (case-insensitive)
    // - Deduplicated by prospect_id (DISTINCT ON)
    // - Excludes prospects already in campaign_recipients for this campaign
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

    // --------------------------------------------------------
    // 5. Track filtering stats
    // --------------------------------------------------------
    // Get total prospects in list for stats
    const totalInListRes = await client.query(
      `SELECT COUNT(*) AS count FROM list_members 
       WHERE list_id = $1 AND organizer_id = $2`,
      [campaign.list_id, organizerId]
    );
    const totalInList = parseInt(totalInListRes.rows[0].count, 10) || 0;

    // Count exclusions for stats
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

    // --------------------------------------------------------
    // 6. Insert campaign_recipients (no ON CONFLICT)
    // --------------------------------------------------------
    let insertedCount = 0;

    if (eligibleProspects.length > 0) {
      // Build bulk insert
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

      // Simple INSERT - deduplication already handled in SELECT
      const insertQuery = `
        INSERT INTO campaign_recipients 
          (organizer_id, campaign_id, prospect_id, email, name, meta)
        VALUES ${placeholders.join(', ')}
        RETURNING id
      `;

      const insertRes = await client.query(insertQuery, values);
      insertedCount = insertRes.rows.length;
    }

    // --------------------------------------------------------
    // 7. Update campaign to READY
    // --------------------------------------------------------
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
      // This shouldn't happen due to transaction, but safety check
      await client.query('ROLLBACK');
      return res.status(500).json({ 
        error: "Failed to update campaign status" 
      });
    }

    const updatedCampaign = updateRes.rows[0];

    // Commit transaction
    await client.query('COMMIT');

    // --------------------------------------------------------
    // 8. Return success response
    // --------------------------------------------------------
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

module.exports = router;
