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
 * Basit UUID kontrolü
 * Postgres'te uuid sütununa "undefined" göndermeyi engellemek için.
 */
function isValidUuid(id) {
  return typeof id === "string" && /^[0-9a-fA-F-]{36}$/.test(id);
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
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
    const offset = (page - 1) * limit;
    const { search, status } = req.query;

    const where = ['organizer_id = $1'];
    const params = [organizer_id];
    let idx = 2;

    if (status) {
      where.push(`status = $${idx}`);
      params.push(status);
      idx++;
    }

    if (search) {
      where.push(`(input ILIKE $${idx} OR CAST(id AS TEXT) ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    const baseWhere = `WHERE ${where.join(' AND ')}`;

    const jobsRes = await db.query(
      `SELECT *
       FROM mining_jobs
       ${baseWhere}
       ORDER BY created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    );

    const countRes = await db.query(
      `SELECT
         COUNT(*)::int AS total,
         COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0)::int AS pending,
         COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0)::int AS running,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0)::int AS completed,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::int AS failed,
         COALESCE(SUM(total_emails_raw), 0)::int AS total_emails
       FROM mining_jobs
       ${baseWhere}`,
      params
    );

    const stats = countRes.rows[0] || {};

    return res.json({
      jobs: jobsRes.rows,
      total: stats.total || 0,
      stats: {
        total: stats.total || 0,
        pending: stats.pending || 0,
        running: stats.running || 0,
        completed: stats.completed || 0,
        failed: stats.failed || 0,
        total_emails: stats.total_emails || 0
      }
    });

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

    // UUID olmayan veya "undefined" gelen id'lerde DB'ye gitmeyelim
    if (!job_id || job_id === 'undefined' || !isValidUuid(job_id)) {
      return res.status(400).json({ error: "Invalid job id" });
    }

    const result = await db.query(
      `SELECT *
       FROM mining_jobs
       WHERE id = $1 AND organizer_id = $2`,
      [job_id, organizer_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    return res.json({ job: result.rows[0] });

  } catch (err) {
    console.error("GET /mining/jobs/:id error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/mining/jobs/:id
 */
router.patch('/api/mining/jobs/:id', authRequired, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;
    const job_id = req.params.id;

    const allowedFields = [
      'notes',
      'status',
      'input',
      'type',
      'stats',
      'total_found',
      'total_prospects_created',
      'total_emails_raw',
      'error'
    ];

    const sets = [];
    const values = [];
    let idx = 1;

    allowedFields.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        sets.push(`${field} = $${idx}`);
        values.push(req.body[field]);
        idx++;
      }
    });

    if (sets.length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    values.push(job_id, organizer_id);

    const result = await db.query(
      `UPDATE mining_jobs
       SET ${sets.join(', ')}
       WHERE id = $${idx} AND organizer_id = $${idx + 1}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    return res.json({ job: result.rows[0] });
  } catch (err) {
    console.error("PATCH /mining/jobs/:id error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/mining/jobs/:id
 */
router.delete('/api/mining/jobs/:id', authRequired, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;
    const job_id = req.params.id;

    const result = await db.query(
      `UPDATE mining_jobs
       SET status = 'cancelled'
       WHERE id = $1 AND organizer_id = $2
       RETURNING *`,
      [job_id, organizer_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    return res.json({ job: result.rows[0], deleted: true });
  } catch (err) {
    console.error("DELETE /mining/jobs/:id error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/mining/jobs/:id/retry
 */
router.post('/api/mining/jobs/:id/retry', authRequired, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;
    const job_id = req.params.id;

    const jobRes = await db.query(
      `SELECT * FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
      [job_id, organizer_id]
    );

    if (jobRes.rows.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    const job = jobRes.rows[0];

    const newJobRes = await db.query(
      `INSERT INTO mining_jobs (organizer_id, type, input, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING *`,
      [organizer_id, job.type, job.input]
    );

    return res.json({ new_job_id: newJobRes.rows[0].id, job: newJobRes.rows[0] });
  } catch (err) {
    console.error("POST /mining/jobs/:id/retry error:", err);
    return res.status(500).json({ error: err.message });
  }
});

async function updateJobStatus(job_id, organizer_id, status) {
  const result = await db.query(
    `UPDATE mining_jobs
     SET status = $1
     WHERE id = $2 AND organizer_id = $3
     RETURNING *`,
    [status, job_id, organizer_id]
  );

  if (result.rows.length === 0) {
    const error = new Error('Job not found');
    error.code = 'NOT_FOUND';
    throw error;
  }

  return result.rows[0];
}

router.post('/api/mining/jobs/:id/pause', authRequired, async (req, res) => {
  try {
    const job = await updateJobStatus(req.params.id, req.auth.organizer_id, 'paused');
    return res.json({ job });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: err.message });
    }
    console.error("POST /mining/jobs/:id/pause error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/api/mining/jobs/:id/resume', authRequired, async (req, res) => {
  try {
    const job = await updateJobStatus(req.params.id, req.auth.organizer_id, 'running');
    return res.json({ job });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: err.message });
    }
    console.error("POST /mining/jobs/:id/resume error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/api/mining/jobs/:id/cancel', authRequired, async (req, res) => {
  try {
    const job = await updateJobStatus(req.params.id, req.auth.organizer_id, 'cancelled');
    return res.json({ job });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: err.message });
    }
    console.error("POST /mining/jobs/:id/cancel error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/mining/jobs/:id/logs
 */
router.get('/api/mining/jobs/:id/logs', authRequired, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;
    const job_id = req.params.id;

    const jobRes = await db.query(
      `SELECT id FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
      [job_id, organizer_id]
    );

    if (jobRes.rows.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    // TODO: Replace with real log storage
    return res.json({ logs: [] });
  } catch (err) {
    console.error("GET /mining/jobs/:id/logs error:", err);
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

    // UUID olmayan veya "undefined" gelen id'lerde DB'ye gitmeyelim
    if (!job_id || job_id === 'undefined' || !isValidUuid(job_id)) {
      return res.status(400).json({ error: "Invalid job id" });
    }

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
