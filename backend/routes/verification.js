const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');
const { checkCredits, verifySingle, queueEmails, processQueue, mapStatus } = require('../services/verificationService');

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

function authRequired(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No token" });
  const token = authHeader.replace("Bearer ", "").trim();
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// GET /api/verification/credits — Check ZeroBounce credit balance
router.get('/credits', authRequired, async (req, res) => {
  try {
    const { organizer_id } = req.auth;

    const orgRes = await db.query(
      `SELECT zerobounce_api_key FROM organizers WHERE id = $1`,
      [organizer_id]
    );

    if (orgRes.rows.length === 0) {
      return res.status(404).json({ error: 'Organizer not found' });
    }

    const apiKey = orgRes.rows[0].zerobounce_api_key;
    if (!apiKey) {
      return res.status(400).json({ error: 'ZeroBounce API key not configured. Set it in Settings.' });
    }

    const result = await checkCredits(apiKey);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json({ credits: result.credits });
  } catch (err) {
    console.error('GET /api/verification/credits error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/verification/verify-single — Verify one email immediately
router.post('/verify-single', authRequired, async (req, res) => {
  try {
    const { organizer_id } = req.auth;
    const { email } = req.body;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Get API key
    const orgRes = await db.query(
      `SELECT zerobounce_api_key FROM organizers WHERE id = $1`,
      [organizer_id]
    );

    if (orgRes.rows.length === 0) {
      return res.status(404).json({ error: 'Organizer not found' });
    }

    const apiKey = orgRes.rows[0].zerobounce_api_key;
    if (!apiKey) {
      return res.status(400).json({ error: 'ZeroBounce API key not configured' });
    }

    // Verify
    const result = await verifySingle(apiKey, normalizedEmail);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    const liffyStatus = result.status;
    const now = new Date().toISOString();

    // Dual-write: update persons table
    await db.query(
      `UPDATE persons SET verification_status = $1, verified_at = $2, updated_at = NOW()
       WHERE organizer_id = $3 AND LOWER(email) = $4`,
      [liffyStatus, now, organizer_id, normalizedEmail]
    );

    // Dual-write: update prospects table (legacy)
    await db.query(
      `UPDATE prospects SET verification_status = $1
       WHERE organizer_id = $2 AND LOWER(email) = $3`,
      [liffyStatus, organizer_id, normalizedEmail]
    );

    res.json({
      email: normalizedEmail,
      status: liffyStatus,
      sub_status: result.sub_status
    });
  } catch (err) {
    console.error('POST /api/verification/verify-single error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/verification/verify-list — Queue a list or array of emails for verification
router.post('/verify-list', authRequired, async (req, res) => {
  try {
    const { organizer_id } = req.auth;
    const { list_id, emails } = req.body;

    // Check API key exists
    const orgRes = await db.query(
      `SELECT zerobounce_api_key FROM organizers WHERE id = $1`,
      [organizer_id]
    );
    if (orgRes.rows.length === 0 || !orgRes.rows[0].zerobounce_api_key) {
      return res.status(400).json({ error: 'ZeroBounce API key not configured' });
    }

    let emailList = [];

    if (list_id) {
      // Fetch emails from list_members JOIN prospects
      const membersRes = await db.query(
        `SELECT DISTINCT p.email
         FROM list_members lm
         JOIN prospects p ON p.id = lm.prospect_id
         WHERE lm.list_id = $1 AND lm.organizer_id = $2
           AND p.email IS NOT NULL AND TRIM(p.email) != ''`,
        [list_id, organizer_id]
      );
      emailList = membersRes.rows.map(r => r.email);
    } else if (emails && Array.isArray(emails)) {
      emailList = emails;
    } else {
      return res.status(400).json({ error: 'Provide list_id or emails array' });
    }

    if (emailList.length === 0) {
      return res.json({ queued: 0, already_verified: 0, already_in_queue: 0, total: 0 });
    }

    // Filter out already-verified emails (valid, invalid, catchall) from persons table
    // Only queue emails where verification_status IS NULL or 'unknown'
    const normalizedEmails = emailList.map(e => e.toLowerCase().trim());
    const verifiedRes = await db.query(
      `SELECT LOWER(email) AS email, verification_status
       FROM persons
       WHERE organizer_id = $1
         AND LOWER(email) = ANY($2)
         AND verification_status IN ('valid', 'invalid', 'catchall')`,
      [organizer_id, normalizedEmails]
    );
    const alreadyVerifiedSet = new Set(verifiedRes.rows.map(r => r.email));
    const already_verified = alreadyVerifiedSet.size;

    // Only queue emails that need verification
    const emailsToVerify = emailList.filter(
      e => !alreadyVerifiedSet.has(e.toLowerCase().trim())
    );

    if (emailsToVerify.length === 0) {
      return res.json({ queued: 0, already_verified, already_in_queue: 0, total: emailList.length });
    }

    const result = await queueEmails(organizer_id, emailsToVerify, list_id ? 'list' : 'manual');

    res.json({
      queued: result.queued,
      already_verified,
      already_in_queue: result.skipped,
      total: emailList.length
    });
  } catch (err) {
    console.error('POST /api/verification/verify-list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/verification/queue-status — Queue status counts
router.get('/queue-status', authRequired, async (req, res) => {
  try {
    const { organizer_id } = req.auth;
    const { list_id } = req.query;

    let query;
    let params;

    if (list_id) {
      // Filter by list: join with list_members to find matching emails
      query = `
        SELECT vq.status, COUNT(*) as count
        FROM verification_queue vq
        WHERE vq.organizer_id = $1
          AND LOWER(vq.email) IN (
            SELECT LOWER(p.email)
            FROM list_members lm
            JOIN prospects p ON p.id = lm.prospect_id
            WHERE lm.list_id = $2 AND lm.organizer_id = $1
          )
        GROUP BY vq.status`;
      params = [organizer_id, list_id];
    } else {
      query = `
        SELECT status, COUNT(*) as count
        FROM verification_queue
        WHERE organizer_id = $1
        GROUP BY status`;
      params = [organizer_id];
    }

    const result = await db.query(query, params);

    const counts = { pending: 0, processing: 0, completed: 0, failed: 0 };
    let total = 0;
    for (const row of result.rows) {
      const c = parseInt(row.count, 10);
      counts[row.status] = c;
      total += c;
    }
    counts.total = total;

    res.json(counts);
  } catch (err) {
    console.error('GET /api/verification/queue-status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/verification/process-queue — Manual trigger for queue processing
router.post('/process-queue', authRequired, async (req, res) => {
  try {
    const { organizer_id } = req.auth;
    const batchSize = Math.min(parseInt(req.body.batch_size, 10) || 50, 200);

    const result = await processQueue(organizer_id, batchSize);

    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    res.json({
      processed: result.processed,
      results: result.results
    });
  } catch (err) {
    console.error('POST /api/verification/process-queue error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
