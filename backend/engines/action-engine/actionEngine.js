/**
 * actionEngine.js — Blueprint Section 6: Trigger Rules + Priority Scoring.
 *
 * 6 triggers: reply_received (P1), quote_no_response (P2), rebooking_due (P2),
 *             sequence_exhausted (P3), engaged_hot (P3), manual_flag (P4).
 *
 * Two modes:
 *   1. Near-real-time: evaluateForPerson() called from webhooks/sequence hooks.
 *   2. Periodic: reconcile() called every 15 min by actionWorker.
 */

const db = require('../../db');

// Engagement score weights
const SCORE_OPEN = 1;
const SCORE_CLICK = 3;
const SCORE_REPLY = 10;
const SCORE_INACTIVE_PENALTY = -2; // per 7-day inactive period

// ---------------------------------------------------------------------------
// evaluateForPerson — run all (or hinted) trigger rules for a person
// ---------------------------------------------------------------------------
async function evaluateForPerson(personId, organizerId, triggerHint) {
  if (!personId || !organizerId) return;

  try {
    if (triggerHint === 'reply_received') {
      await checkReplyReceived(personId, organizerId);
    } else if (triggerHint === 'sequence_exhausted') {
      await checkSequenceExhausted(personId, organizerId);
    } else if (triggerHint === 'engaged_hot') {
      await checkEngagedHot(personId, organizerId);
    } else {
      // Full evaluation (reconcile) — reply_received is real-time only (no dedup),
      // so skip it here to avoid creating duplicate items on every 15-min cycle.
      await checkSequenceExhausted(personId, organizerId);
      await checkEngagedHot(personId, organizerId);
      // T3 + T4 are stubs
    }
  } catch (err) {
    console.error(`[ActionEngine] evaluateForPerson error (${personId}):`, err.message);
  }
}

// ---------------------------------------------------------------------------
// T1: reply_received — Priority 1
// NO DEDUP: every reply creates a new action item.
// Salesperson marks done/dismiss; new reply → new action item appears.
// Only called from real-time path (triggerHint='reply_received'), NOT from reconcile.
// ---------------------------------------------------------------------------
async function checkReplyReceived(personId, organizerId) {
  // Find most recent reply event for this person
  const replyRes = await db.query(
    `SELECT ce.campaign_id, ce.email, ce.occurred_at, ce.reason,
            c.created_by_user_id, c.name AS campaign_name
     FROM campaign_events ce
     JOIN campaigns c ON c.id = ce.campaign_id
     WHERE ce.person_id = $1 AND ce.organizer_id = $2 AND ce.event_type = 'reply'
     ORDER BY ce.occurred_at DESC LIMIT 1`,
    [personId, organizerId]
  );

  if (replyRes.rows.length === 0) return;

  const reply = replyRes.rows[0];
  const assignedTo = reply.created_by_user_id || await getFallbackOwner(organizerId);
  if (!assignedTo) return;

  const detail = reply.reason
    ? `Reply received: "${reply.reason.substring(0, 80)}"`
    : `Reply received from campaign "${reply.campaign_name || 'unknown'}"`;

  await insertActionItem({
    organizerId,
    assignedTo,
    personId,
    campaignId: reply.campaign_id,
    triggerReason: 'reply_received',
    triggerDetail: detail,
    priority: 1,
    priorityLabel: 'P1',
    lastActivityAt: reply.occurred_at,
    engagementScore: await computeEngagementScore(personId, organizerId),
  });
}

// ---------------------------------------------------------------------------
// T2: sequence_exhausted — Priority 3
// ---------------------------------------------------------------------------
async function checkSequenceExhausted(personId, organizerId) {
  // Find completed sequence recipients for this person where no reply exists
  const seqRes = await db.query(
    `SELECT sr.campaign_id, sr.last_sent_step, sr.updated_at,
            c.created_by_user_id, c.name AS campaign_name
     FROM sequence_recipients sr
     JOIN campaigns c ON c.id = sr.campaign_id
     WHERE sr.person_id = $1 AND sr.organizer_id = $2 AND sr.status = 'completed'
       AND NOT EXISTS (
         SELECT 1 FROM campaign_events ce
         WHERE ce.person_id = $1 AND ce.campaign_id = sr.campaign_id AND ce.event_type = 'reply'
       )
     ORDER BY sr.updated_at DESC LIMIT 1`,
    [personId, organizerId]
  );

  if (seqRes.rows.length === 0) return;

  const seq = seqRes.rows[0];
  const assignedTo = seq.created_by_user_id || await getFallbackOwner(organizerId);
  if (!assignedTo) return;

  await upsertActionItem({
    organizerId,
    assignedTo,
    personId,
    campaignId: seq.campaign_id,
    triggerReason: 'sequence_exhausted',
    triggerDetail: `Sequence completed — no response after ${seq.last_sent_step} emails`,
    priority: 3,
    priorityLabel: 'P3',
    lastActivityAt: seq.updated_at,
    engagementScore: await computeEngagementScore(personId, organizerId),
  });
}

// ---------------------------------------------------------------------------
// T3: quote_no_response — Priority 2 (STUB)
// ---------------------------------------------------------------------------
async function checkQuoteNoResponse(/* personId, organizerId */) {
  // TODO: Implement when quotes table is created (Blueprint Phase 1C)
}

// ---------------------------------------------------------------------------
// T4: rebooking_due — Priority 2 (STUB)
// ---------------------------------------------------------------------------
async function checkRebookingDue(/* personId, organizerId */) {
  // TODO: Implement when ELIZA shared DB connected (Blueprint Phase 0)
}

// ---------------------------------------------------------------------------
// T5: engaged_hot — Priority 3 (Blueprint Section 6 strict rules)
//
// Action item created ONLY for these combinations:
//   A) 2+ distinct open events on DIFFERENT days in 7 days
//   B) Click + past exhibitor history (tags / past contract)
//   C) Click + high_value tag
//   D) Click + link URL contains floorplan/pricing/register/book/stand/booth
//
// Single click without qualifying context → NO action item.
// Single open → NO action item.
// ---------------------------------------------------------------------------
async function checkEngagedHot(personId, organizerId) {
  // RULE: If person has a reply, engaged_hot is suppressed (reply_received takes precedence)
  const hasReply = await db.query(
    `SELECT 1 FROM campaign_events
     WHERE person_id = $1 AND organizer_id = $2 AND event_type = 'reply'
     LIMIT 1`,
    [personId, organizerId]
  );
  if (hasReply.rows.length > 0) return;

  // RULE: Skip if open engaged_hot action item already exists (dedup)
  const hasOpen = await db.query(
    `SELECT 1 FROM action_items
     WHERE person_id = $1 AND organizer_id = $2
       AND trigger_reason = 'engaged_hot' AND status IN ('open', 'in_progress')
     LIMIT 1`,
    [personId, organizerId]
  );
  if (hasOpen.rows.length > 0) return;

  // --- COMBINATION A: 2+ distinct opens on different days in 7 days ---
  const openRes = await db.query(
    `SELECT COUNT(DISTINCT DATE(occurred_at)) AS distinct_days
     FROM campaign_events
     WHERE person_id = $1 AND organizer_id = $2 AND event_type = 'open'
       AND occurred_at >= NOW() - INTERVAL '7 days'`,
    [personId, organizerId]
  );
  const distinctOpenDays = parseInt(openRes.rows[0]?.distinct_days || 0, 10);

  if (distinctOpenDays >= 2) {
    const latestOpen = await db.query(
      `SELECT ce.campaign_id, c.created_by_user_id, ce.occurred_at
       FROM campaign_events ce
       JOIN campaigns c ON c.id = ce.campaign_id
       WHERE ce.person_id = $1 AND ce.organizer_id = $2 AND ce.event_type = 'open'
         AND ce.occurred_at >= NOW() - INTERVAL '7 days'
       ORDER BY ce.occurred_at DESC LIMIT 1`,
      [personId, organizerId]
    );
    if (latestOpen.rows.length > 0) {
      const open = latestOpen.rows[0];
      const assignedTo = open.created_by_user_id || await getFallbackOwner(organizerId);
      if (!assignedTo) return;
      await upsertActionItem({
        organizerId,
        assignedTo,
        personId,
        campaignId: open.campaign_id,
        triggerReason: 'engaged_hot',
        triggerDetail: `Opened on ${distinctOpenDays} different days in the last week`,
        priority: 3,
        priorityLabel: 'P3',
        lastActivityAt: open.occurred_at,
        engagementScore: await computeEngagementScore(personId, organizerId),
      });
      return;
    }
  }

  // --- COMBINATION B/C/D: Click + qualifying context ---
  const clicks = await db.query(
    `SELECT ce.url, ce.occurred_at, ce.campaign_id, c.created_by_user_id
     FROM campaign_events ce
     JOIN campaigns c ON c.id = ce.campaign_id
     WHERE ce.person_id = $1 AND ce.organizer_id = $2 AND ce.event_type = 'click'
       AND ce.occurred_at >= NOW() - INTERVAL '30 days'
     ORDER BY ce.occurred_at DESC
     LIMIT 5`,
    [personId, organizerId]
  );

  if (clicks.rows.length === 0) return; // No clicks → no action item

  // COMBINATION D: Check if any click URL is high-value
  const HIGH_VALUE_KEYWORDS = ['floorplan', 'pricing', 'register', 'book', 'stand', 'booth'];
  const highValueClick = clicks.rows.find(c => {
    const url = (c.url || '').toLowerCase();
    return HIGH_VALUE_KEYWORDS.some(kw => url.includes(kw));
  });

  if (highValueClick) {
    const assignedTo = highValueClick.created_by_user_id || await getFallbackOwner(organizerId);
    if (!assignedTo) return;
    await upsertActionItem({
      organizerId,
      assignedTo,
      personId,
      campaignId: highValueClick.campaign_id,
      triggerReason: 'engaged_hot',
      triggerDetail: `Clicked high-value link: ${(highValueClick.url || '').substring(0, 80)}`,
      priority: 3,
      priorityLabel: 'P3',
      lastActivityAt: highValueClick.occurred_at,
      engagementScore: await computeEngagementScore(personId, organizerId),
    });
    return;
  }

  // Click exists but no qualifying context → NO action item
  // Blueprint: "Single click without qualifying context" does NOT create action item
  return;
}

// ---------------------------------------------------------------------------
// reconcile — periodic full scan for an organizer
// ---------------------------------------------------------------------------
async function reconcile(organizerId) {
  // 1) Resurface snoozed items
  await db.query(
    `UPDATE action_items SET status = 'open', snoozed_until = NULL
     WHERE organizer_id = $1 AND status = 'snoozed' AND snoozed_until <= NOW()`,
    [organizerId]
  );

  // 2) Find persons with recent campaign activity (last 7 days)
  const personsRes = await db.query(
    `SELECT DISTINCT person_id FROM campaign_events
     WHERE organizer_id = $1 AND person_id IS NOT NULL
       AND occurred_at >= NOW() - INTERVAL '7 days'`,
    [organizerId]
  );

  for (const row of personsRes.rows) {
    try {
      await evaluateForPerson(row.person_id, organizerId, null);
    } catch (err) {
      console.error(`[ActionEngine] Reconcile error for ${row.person_id}:`, err.message);
    }
  }

  // 3) Check completed sequences without action items
  const seqRes = await db.query(
    `SELECT DISTINCT sr.person_id FROM sequence_recipients sr
     WHERE sr.organizer_id = $1 AND sr.status = 'completed'
       AND sr.person_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM action_items ai
         WHERE ai.person_id = sr.person_id AND ai.organizer_id = $1
           AND ai.trigger_reason = 'sequence_exhausted'
           AND ai.status IN ('open', 'in_progress')
       )
       AND NOT EXISTS (
         SELECT 1 FROM campaign_events ce
         WHERE ce.person_id = sr.person_id AND ce.campaign_id = sr.campaign_id
           AND ce.event_type = 'reply'
       )`,
    [organizerId]
  );

  for (const row of seqRes.rows) {
    try {
      await checkSequenceExhausted(row.person_id, organizerId);
    } catch (err) {
      console.error(`[ActionEngine] Reconcile seq error for ${row.person_id}:`, err.message);
    }
  }

  // 4) Update engagement scores on open items
  await db.query(
    `UPDATE action_items ai SET engagement_score = sub.score
     FROM (
       SELECT ai2.id,
         COALESCE(SUM(CASE
           WHEN ce.event_type = 'open' THEN ${SCORE_OPEN}
           WHEN ce.event_type = 'click' THEN ${SCORE_CLICK}
           WHEN ce.event_type = 'reply' THEN ${SCORE_REPLY}
           ELSE 0
         END), 0)
         + CASE WHEN MAX(ce.occurred_at) < NOW() - INTERVAL '7 days' THEN ${SCORE_INACTIVE_PENALTY} ELSE 0 END
         AS score
       FROM action_items ai2
       LEFT JOIN campaign_events ce ON ce.person_id = ai2.person_id AND ce.organizer_id = ai2.organizer_id
       WHERE ai2.organizer_id = $1 AND ai2.status IN ('open', 'in_progress')
       GROUP BY ai2.id
     ) sub
     WHERE ai.id = sub.id`,
    [organizerId]
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert a new action item without dedup (used for reply_received).
 * Every call creates a new row — no ON CONFLICT.
 */
async function insertActionItem({ organizerId, assignedTo, personId, campaignId, triggerReason, triggerDetail, priority, priorityLabel, lastActivityAt, engagementScore }) {
  await db.query(
    `INSERT INTO action_items
       (organizer_id, assigned_to, person_id, campaign_id, trigger_reason, trigger_detail,
        priority, priority_label, status, last_activity_at, engagement_score)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $10)`,
    [organizerId, assignedTo, personId, campaignId || null, triggerReason, triggerDetail,
     priority, priorityLabel, lastActivityAt || new Date().toISOString(), engagementScore || 0]
  );
}

async function upsertActionItem({ organizerId, assignedTo, personId, campaignId, triggerReason, triggerDetail, priority, priorityLabel, lastActivityAt, engagementScore }) {
  // Uses the unique partial index idx_action_items_dedup for conflict resolution (excludes reply_received)
  await db.query(
    `INSERT INTO action_items
       (organizer_id, assigned_to, person_id, campaign_id, trigger_reason, trigger_detail,
        priority, priority_label, status, last_activity_at, engagement_score)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $10)
     ON CONFLICT (organizer_id, person_id, trigger_reason) WHERE status IN ('open', 'in_progress') AND trigger_reason <> 'reply_received'
     DO UPDATE SET
       trigger_detail = EXCLUDED.trigger_detail,
       last_activity_at = EXCLUDED.last_activity_at,
       engagement_score = EXCLUDED.engagement_score,
       campaign_id = COALESCE(EXCLUDED.campaign_id, action_items.campaign_id)`,
    [organizerId, assignedTo, personId, campaignId || null, triggerReason, triggerDetail,
     priority, priorityLabel, lastActivityAt || new Date().toISOString(), engagementScore || 0]
  );
}

async function computeEngagementScore(personId, organizerId) {
  const res = await db.query(
    `SELECT
       COALESCE(SUM(CASE event_type
         WHEN 'open' THEN ${SCORE_OPEN}
         WHEN 'click' THEN ${SCORE_CLICK}
         WHEN 'reply' THEN ${SCORE_REPLY}
         ELSE 0
       END), 0) AS score
     FROM campaign_events
     WHERE person_id = $1 AND organizer_id = $2
       AND occurred_at >= NOW() - INTERVAL '30 days'`,
    [personId, organizerId]
  );
  return parseInt(res.rows[0]?.score || 0, 10);
}

async function getFallbackOwner(organizerId) {
  const res = await db.query(
    `SELECT id FROM users WHERE organizer_id = $1 AND role = 'owner' LIMIT 1`,
    [organizerId]
  );
  return res.rows[0]?.id || null;
}

module.exports = {
  evaluateForPerson,
  reconcile,
  // Exported for direct use by manual_flag route
  upsertActionItem,
  computeEngagementScore,
  getFallbackOwner,
};
