const axios = require('axios');
const db = require('../db');

const ZEROBOUNCE_BASE = 'https://api.zerobounce.net/v2';

// ZeroBounce status → Liffy status mapping
const STATUS_MAP = {
  'valid': 'valid',
  'catch-all': 'catchall',
  'unknown': 'unknown',
  'invalid': 'invalid',
  'spamtrap': 'invalid',
  'abuse': 'invalid',
  'do_not_mail': 'invalid'
};

function mapStatus(zbStatus) {
  const normalized = (zbStatus || '').toLowerCase().trim();
  return STATUS_MAP[normalized] || 'unknown';
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Check ZeroBounce credit balance.
 * Never throws — returns { success, credits } or { success: false, error }.
 */
async function checkCredits(apiKey) {
  try {
    const res = await axios.get(`${ZEROBOUNCE_BASE}/getcredits`, {
      params: { api_key: apiKey },
      timeout: 10000
    });
    const credits = parseInt(res.data.Credits, 10);
    if (isNaN(credits) || credits < 0) {
      return { success: false, error: 'Invalid API key or response' };
    }
    return { success: true, credits };
  } catch (err) {
    return { success: false, error: err.response?.data?.error || err.message };
  }
}

/**
 * Verify a single email via ZeroBounce.
 * Never throws — returns { success, status, sub_status, raw_response } or { success: false, error }.
 */
async function verifySingle(apiKey, email) {
  try {
    const res = await axios.get(`${ZEROBOUNCE_BASE}/validate`, {
      params: {
        api_key: apiKey,
        email: email,
        ip_address: ''
      },
      timeout: 30000
    });

    const data = res.data;
    const liffyStatus = mapStatus(data.status);

    return {
      success: true,
      status: liffyStatus,
      sub_status: data.sub_status || null,
      raw_response: data
    };
  } catch (err) {
    return { success: false, error: err.response?.data?.error || err.message };
  }
}

/**
 * Queue emails for verification.
 * Looks up person_id and prospect_id for each email.
 * Uses ON CONFLICT to skip already-queued (pending/processing) emails.
 * Returns { queued, skipped }.
 */
async function queueEmails(organizerId, emails, source = 'manual') {
  let queued = 0;
  let skipped = 0;

  for (const email of emails) {
    const normalizedEmail = email.toLowerCase().trim();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      skipped++;
      continue;
    }

    try {
      // Lookup person_id
      const personRes = await db.query(
        `SELECT id FROM persons WHERE organizer_id = $1 AND LOWER(email) = $2`,
        [organizerId, normalizedEmail]
      );
      const personId = personRes.rows.length > 0 ? personRes.rows[0].id : null;

      // Lookup prospect_id
      const prospectRes = await db.query(
        `SELECT id FROM prospects WHERE organizer_id = $1 AND LOWER(email) = $2`,
        [organizerId, normalizedEmail]
      );
      const prospectId = prospectRes.rows.length > 0 ? prospectRes.rows[0].id : null;

      const result = await db.query(
        `INSERT INTO verification_queue (organizer_id, email, person_id, prospect_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (organizer_id, LOWER(email)) WHERE status IN ('pending', 'processing')
         DO NOTHING
         RETURNING id`,
        [organizerId, normalizedEmail, personId, prospectId]
      );

      if (result.rows.length > 0) {
        queued++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(`[Verification] Queue error for ${normalizedEmail}:`, err.message);
      skipped++;
    }
  }

  return { queued, skipped };
}

/**
 * Process a single verification item — API call + DB writes.
 * Returns result object. Never throws.
 */
async function processOneItem(client, apiKey, item, organizerId) {
  try {
    const verifyResult = await verifySingle(apiKey, item.email);

    if (verifyResult.success) {
      const liffyStatus = verifyResult.status;
      const now = new Date().toISOString();

      // Dual-write: update persons table
      if (item.person_id) {
        await client.query(
          `UPDATE persons SET verification_status = $1, verified_at = $2, updated_at = NOW()
           WHERE id = $3 AND organizer_id = $4`,
          [liffyStatus, now, item.person_id, organizerId]
        );
      }

      // Dual-write: update prospects table (legacy)
      if (item.prospect_id) {
        await client.query(
          `UPDATE prospects SET verification_status = $1
           WHERE id = $2 AND organizer_id = $3`,
          [liffyStatus, item.prospect_id, organizerId]
        );
      }

      // Mark queue item as completed
      await client.query(
        `UPDATE verification_queue SET status = 'completed', result = $1, processed_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(verifyResult.raw_response), item.id]
      );

      return { email: item.email, status: liffyStatus, sub_status: verifyResult.sub_status, success: true };
    } else {
      // API call failed — mark as failed
      await client.query(
        `UPDATE verification_queue SET status = 'failed', result = $1, processed_at = NOW()
         WHERE id = $2`,
        [JSON.stringify({ error: verifyResult.error }), item.id]
      );
      return { email: item.email, status: 'failed', error: verifyResult.error, success: false };
    }
  } catch (itemErr) {
    console.error(`[Verification] Process error for ${item.email}:`, itemErr.message);
    await client.query(
      `UPDATE verification_queue SET status = 'failed', result = $1, processed_at = NOW()
       WHERE id = $2`,
      [JSON.stringify({ error: itemErr.message }), item.id]
    );
    return { email: item.email, status: 'failed', error: itemErr.message, success: false };
  }
}

/**
 * Process pending items from verification_queue.
 * Uses FOR UPDATE SKIP LOCKED for safe concurrent processing.
 * Dual-writes to prospects.verification_status + persons.verification_status.
 * Processes in parallel chunks of 10 (safe within ZeroBounce ~20 calls/sec limit).
 * Returns { processed, results[] }.
 */
const PARALLEL_CHUNK_SIZE = 10;

async function processQueue(organizerId, batchSize = 100) {
  // Get API key for this organizer
  const orgRes = await db.query(
    `SELECT zerobounce_api_key FROM organizers WHERE id = $1`,
    [organizerId]
  );
  if (orgRes.rows.length === 0 || !orgRes.rows[0].zerobounce_api_key) {
    return { processed: 0, results: [], error: 'No ZeroBounce API key configured' };
  }
  const apiKey = orgRes.rows[0].zerobounce_api_key;

  const client = await db.connect();
  const results = [];
  let processed = 0;

  try {
    // Grab pending items with row-level locking
    await client.query('BEGIN');
    const pendingRes = await client.query(
      `SELECT id, email, person_id, prospect_id
       FROM verification_queue
       WHERE organizer_id = $1 AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [organizerId, batchSize]
    );

    if (pendingRes.rows.length === 0) {
      await client.query('COMMIT');
      return { processed: 0, results: [] };
    }

    // Mark as processing
    const ids = pendingRes.rows.map(r => r.id);
    await client.query(
      `UPDATE verification_queue SET status = 'processing' WHERE id = ANY($1)`,
      [ids]
    );
    await client.query('COMMIT');

    // Process in parallel chunks of PARALLEL_CHUNK_SIZE
    const items = pendingRes.rows;
    for (let i = 0; i < items.length; i += PARALLEL_CHUNK_SIZE) {
      const chunk = items.slice(i, i + PARALLEL_CHUNK_SIZE);
      const chunkResults = await Promise.all(
        chunk.map(item => processOneItem(client, apiKey, item, organizerId))
      );

      for (const r of chunkResults) {
        results.push(r);
        if (r.success) processed++;
      }

      // Brief pause between chunks to stay under rate limit (~20 calls/sec)
      if (i + PARALLEL_CHUNK_SIZE < items.length) {
        await sleep(600);
      }
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return { processed, results };
}

module.exports = {
  checkCredits,
  verifySingle,
  queueEmails,
  processQueue,
  mapStatus
};
