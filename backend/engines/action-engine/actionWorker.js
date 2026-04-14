/**
 * actionWorker.js — Periodic reconciliation for the Action Engine.
 * Runs every 15 minutes: evaluates triggers, resurfaces snoozed items,
 * updates engagement scores.
 */

const db = require('../../db');
const { reconcile } = require('./actionEngine');

const POLL_INTERVAL_MS = parseInt(process.env.ACTION_ENGINE_INTERVAL_MS, 10) || 900000; // 15 min

let intervalHandle = null;
let isProcessing = false;

async function poll() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const orgRes = await db.query(`SELECT id FROM organizers`);

    for (const org of orgRes.rows) {
      try {
        await reconcile(org.id);
      } catch (err) {
        console.error(`[ActionWorker] Reconcile failed for org ${org.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[ActionWorker] Poll error:', err.message);
  } finally {
    isProcessing = false;
  }
}

function start() {
  if (intervalHandle) return;
  console.log(`[ActionWorker] Starting (poll every ${POLL_INTERVAL_MS / 1000}s)`);
  intervalHandle = setInterval(poll, POLL_INTERVAL_MS);
  // Run first reconciliation after 30s (let server boot)
  setTimeout(poll, 30000);
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[ActionWorker] Stopped');
  }
}

module.exports = { start, stop };
