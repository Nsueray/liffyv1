const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');
const { runUrlMiningJob } = require('../services/urlMiner');

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

/**
 * Auth middleware
 */
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

/**
 * POST /api/mining/jobs
 */
router.post('/api/mining/jobs', authRequired, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;
    const { type, input } = req.body;

    if (!type || !input) {
      return res.status(400).json({ error: "type and input required" });
    }

    const allowed = ['url', 'pdf', 'excel', 'word', 'other'];
    if (!allowed.includes(type)) {
      return res.status(400).json({ error: "invalid type" });
    }

    const result = await db.query(
      `INSERT INTO mining_jobs
       (organizer_id, type, input, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING *`,
      [organizer_id, type, input]
    );

    return res.json({ success: true, job: result.rows[0] });

  } catch (err) {
    console.error("POST /mining/jobs error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/mining/jobs
 */
router.get('/api/mining/jobs', authRequired, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;

    const result = await db.query(
      `SELECT *
       FROM mining_jobs
       WHERE organizer_id = $1
       ORDER BY created_at DESC`,
      [organizer_id]
    );

    return res.json({ success: true, jobs: result.rows });

  } catch (err) {
    console.error("GET /mining/jobs error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/mining/jobs/:id
 */
router.get('/api/mining/jobs/:id', authRequired, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;
    const job_id = req.params.id;

    const result = await db.query(
      `SELECT *
       FROM mining_jobs
       WHERE id = $1 AND organizer_id = $2`,
      [job_id, organizer_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    return res.json({ success: true, job: result.rows[0] });

  } catch (err) {
    console.error("GET /mining/jobs/:id error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/mining/jobs/:id/run
 * Triggers the mining job
 */
router.post('/api/mining/jobs/:id/run', authRequired, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;
    const job_id = req.params.id;

    // Load job
    const jobRes = await db.query(
      `SELECT * FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
      [job_id, organizer_id]
    );

    if (jobRes.rows.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    const job = jobRes.rows[0];

    if (job.status === 'running') {
      return res.status(400).json({ error: "Job already running" });
    }

    if (job.status === 'completed') {
      return res.status(400).json({ error: "Job already completed" });
    }

    let result;

    if (job.type === 'url') {
      result = await runUrlMiningJob(job_id, organizer_id);
    } else {
      return res.status(400).json({ error: `Mining type '${job.type}' not implemented yet` });
    }

    return res.json(result);

  } catch (err) {
    console.error("POST /mining/jobs/:id/run error:", err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
