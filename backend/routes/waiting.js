/**
 * waiting.js — Waiting Screen endpoint (Blueprint Section 8, Screen 2).
 *
 * Returns active campaigns summary + leads currently in sequences.
 * "What the system is currently processing. Sales rep monitors but doesn't act."
 *
 * GET /api/waiting
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');
const { userScopeFilter } = require('../middleware/userScope');

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

function authRequired(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Missing Authorization header" });
    const token = authHeader.replace("Bearer ", "").trim();
    const payload = jwt.verify(token, JWT_SECRET);
    req.auth = {
      user_id: payload.user_id,
      organizer_id: payload.organizer_id,
      role: payload.role
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

router.get('/', authRequired, async (req, res) => {
  try {
    const { organizer_id } = req.auth;

    // --- Section 1: Active Campaigns ---
    const scope1 = userScopeFilter(req, 2, 'c.created_by_user_id');
    const campaignRes = await db.query(
      `SELECT
         c.id, c.name, c.status, c.campaign_type, c.created_at,
         COUNT(DISTINCT cr.id) AS lead_count,
         COUNT(DISTINCT CASE WHEN cr.opened_at IS NOT NULL THEN cr.id END) AS unique_opens,
         COUNT(DISTINCT CASE WHEN cr.replied_at IS NOT NULL THEN cr.id END) AS reply_count,
         (SELECT COUNT(*) FROM campaign_sequences cs2 WHERE cs2.campaign_id = c.id) AS total_steps
       FROM campaigns c
       LEFT JOIN campaign_recipients cr ON cr.campaign_id = c.id
       WHERE c.organizer_id = $1
         AND c.status IN ('sending', 'scheduled', 'ready', 'completed')
         ${scope1.clause}
       GROUP BY c.id
       ORDER BY c.created_at DESC
       LIMIT 50`,
      [organizer_id, ...scope1.params]
    );

    const campaigns = campaignRes.rows.map(row => {
      const leadCount = parseInt(row.lead_count, 10);
      const uniqueOpens = parseInt(row.unique_opens, 10);
      const replyCount = parseInt(row.reply_count, 10);
      const totalSteps = parseInt(row.total_steps, 10);
      const openRate = leadCount > 0 ? Math.round((uniqueOpens / leadCount) * 100) : 0;

      let stepInfo = null;
      if (row.campaign_type === 'sequence' && totalSteps > 0) {
        stepInfo = `${totalSteps} step${totalSteps > 1 ? 's' : ''} configured`;
      }

      return {
        id: row.id,
        name: row.name,
        status: row.status,
        campaign_type: row.campaign_type,
        lead_count: leadCount,
        open_rate: openRate,
        reply_count: replyCount,
        step_info: stepInfo,
        created_at: row.created_at,
      };
    });

    // --- Section 2: Leads in Sequence ---
    const scope2 = userScopeFilter(req, 2, 'c.created_by_user_id');
    const seqRes = await db.query(
      `SELECT
         sr.id, sr.email, sr.current_step, sr.last_sent_step, sr.status,
         sr.next_send_at, sr.person_id,
         p.first_name, p.last_name,
         c.name AS campaign_name,
         (SELECT COUNT(*) FROM campaign_sequences cs WHERE cs.campaign_id = sr.campaign_id) AS total_steps,
         (SELECT a.company_name FROM affiliations a
          WHERE a.person_id = sr.person_id AND a.organizer_id = sr.organizer_id
            AND a.company_name IS NOT NULL AND a.company_name NOT LIKE '%@%'
          ORDER BY a.created_at DESC LIMIT 1) AS company_name
       FROM sequence_recipients sr
       JOIN campaigns c ON c.id = sr.campaign_id
       LEFT JOIN persons p ON p.id = sr.person_id
       WHERE sr.organizer_id = $1
         AND sr.status = 'active'
         ${scope2.clause}
       ORDER BY sr.next_send_at ASC NULLS LAST
       LIMIT 100`,
      [organizer_id, ...scope2.params]
    );

    const sequenceLeads = seqRes.rows.map(row => {
      const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || null;
      return {
        id: row.id,
        person_id: row.person_id,
        email: row.email,
        name,
        company: row.company_name || null,
        campaign_name: row.campaign_name,
        current_step: row.current_step,
        total_steps: parseInt(row.total_steps, 10),
        next_send_at: row.next_send_at,
        status: row.status,
      };
    });

    // --- Summary ---
    const activeCampaigns = campaigns.filter(c =>
      ['sending', 'scheduled', 'ready'].includes(c.status)
    ).length;
    const totalLeads = campaigns.reduce((sum, c) => sum + c.lead_count, 0);

    res.json({
      campaigns,
      sequence_leads: sequenceLeads,
      summary: {
        active_campaigns: activeCampaigns,
        leads_in_sequence: sequenceLeads.length,
        total_leads: totalLeads,
      },
    });
  } catch (err) {
    console.error('[Waiting] GET / error:', err.message);
    res.status(500).json({ error: 'Failed to fetch waiting data' });
  }
});

module.exports = router;
