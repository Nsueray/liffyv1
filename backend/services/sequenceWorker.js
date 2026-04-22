/**
 * sequenceWorker.js — Background polling worker for multi-touch sequences.
 *
 * Separate from worker.js (single-email campaigns).
 * Polls sequence_recipients WHERE status='active' AND next_send_at <= NOW().
 */

const db = require('../db');
const { processSequenceStep } = require('./sequenceService');

const POLL_INTERVAL_MS = parseInt(process.env.SEQUENCE_POLL_INTERVAL_MS, 10) || 60000; // 60s
const BATCH_SIZE = parseInt(process.env.SEQUENCE_BATCH_SIZE, 10) || 50;

let intervalHandle = null;
let isProcessing = false;

// ---------------------------------------------------------------------------
// checkDailyLimit — returns remaining sends for this user today
// ---------------------------------------------------------------------------
async function getRemainingDailyLimit(userId) {
  if (!userId) return Infinity;

  const limitRes = await db.query(
    `SELECT daily_email_limit FROM users WHERE id = $1`,
    [userId]
  );
  if (limitRes.rows.length === 0) return 0;
  const limit = parseInt(limitRes.rows[0].daily_email_limit, 10);

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

// ---------------------------------------------------------------------------
// pollAndProcess — main polling loop
// ---------------------------------------------------------------------------
async function pollAndProcess() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    // Fetch due recipients
    const res = await db.query(
      `SELECT sr.*, c.created_by_user_id
       FROM sequence_recipients sr
       JOIN campaigns c ON c.id = sr.campaign_id
       WHERE sr.status = 'active'
         AND sr.next_send_at <= NOW()
       ORDER BY sr.next_send_at ASC
       LIMIT $1`,
      [BATCH_SIZE]
    );

    if (res.rows.length === 0) {
      isProcessing = false;
      return;
    }

    console.log(`[SequenceWorker] Processing ${res.rows.length} due recipients`);

    // Group by campaign owner for daily limit tracking
    const limitCache = {};

    for (const sr of res.rows) {
      try {
        // Daily limit check per campaign owner
        const userId = sr.created_by_user_id;
        if (userId) {
          if (!(userId in limitCache)) {
            limitCache[userId] = await getRemainingDailyLimit(userId);
          }
          if (limitCache[userId] <= 0) {
            console.log(`[SequenceWorker] Daily limit reached for user ${userId}, skipping`);
            continue;
          }
          limitCache[userId]--;
        }

        const result = await processSequenceStep(sr);
        if (result.action === 'sent') {
          console.log(`[SequenceWorker] Sent step ${result.step} to ${sr.email}`);
        } else if (result.action === 'skipped') {
          console.log(`[SequenceWorker] Skipped ${sr.email}: ${result.reason}`);
        } else if (result.action === 'error') {
          console.error(`[SequenceWorker] Error for ${sr.email}: ${result.reason}`);
        }
      } catch (err) {
        console.error(`[SequenceWorker] Failed to process ${sr.email}:`, err.message);
      }
    }

    // Check if any sequence campaigns are fully completed
    await checkSequenceCompletion();

  } catch (err) {
    console.error('[SequenceWorker] Poll error:', err.message);
  } finally {
    isProcessing = false;
  }
}

// ---------------------------------------------------------------------------
// checkSequenceCompletion — mark campaigns as completed if all recipients done
// ---------------------------------------------------------------------------
async function checkSequenceCompletion() {
  try {
    // Find sequence campaigns in 'sending' or 'sequencing' that have no active/paused recipients
    const res = await db.query(
      `SELECT c.id, c.organizer_id
       FROM campaigns c
       WHERE c.campaign_type = 'sequence'
         AND c.status IN ('sending', 'sequencing')
         AND NOT EXISTS (
           SELECT 1 FROM sequence_recipients sr
           WHERE sr.campaign_id = c.id AND sr.status IN ('active', 'paused')
         )`
    );

    for (const row of res.rows) {
      await db.query(
        `UPDATE campaigns SET status = 'completed', completed_at = NOW()
         WHERE id = $1 AND organizer_id = $2`,
        [row.id, row.organizer_id]
      );
      console.log(`[SequenceWorker] Campaign ${row.id} sequence completed`);
    }
  } catch (err) {
    console.error('[SequenceWorker] Completion check error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// start / stop
// ---------------------------------------------------------------------------
function start() {
  if (intervalHandle) return;
  console.log(`[SequenceWorker] Starting (poll every ${POLL_INTERVAL_MS / 1000}s, batch ${BATCH_SIZE})`);
  intervalHandle = setInterval(pollAndProcess, POLL_INTERVAL_MS);
  // Run immediately on start
  pollAndProcess();
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[SequenceWorker] Stopped');
  }
}

module.exports = { start, stop };
