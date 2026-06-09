/**
 * dailyLimit.js — Shared daily email limit check for workers.
 *
 * Used by: worker.js (single campaigns), sequenceWorker.js (sequences).
 * Same counting logic as /start gate (campaigns.js) — campaign_events.sent
 * filtered by created_by_user_id + CURRENT_DATE.
 */

const db = require('../db');

/**
 * Returns remaining daily sends for a given user.
 *
 * - userId null/undefined → Infinity (no limit)
 * - daily_email_limit 0 or NULL → Infinity (no limit — matches /start behavior)
 * - Otherwise → max(0, limit - sentToday)
 */
async function getRemainingDailyLimit(userId) {
  if (!userId) return Infinity;

  const limitRes = await db.query(
    `SELECT daily_email_limit FROM users WHERE id = $1`,
    [userId]
  );
  if (limitRes.rows.length === 0) return 0;

  const limit = parseInt(limitRes.rows[0].daily_email_limit, 10) || 0;
  if (limit <= 0) return Infinity;

  const sentRes = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM campaign_events ce
       JOIN campaigns c ON c.id = ce.campaign_id
      WHERE ce.event_type = 'sent'
        AND ce.occurred_at >= CURRENT_DATE
        AND ce.organizer_id = (SELECT organizer_id FROM users WHERE id = $1)
        AND c.created_by_user_id = $1`,
    [userId]
  );
  const sentToday = parseInt(sentRes.rows[0].count, 10);

  return Math.max(0, limit - sentToday);
}

module.exports = { getRemainingDailyLimit };
