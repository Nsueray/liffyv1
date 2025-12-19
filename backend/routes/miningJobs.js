const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');
const { runUrlMiningJob } = require('../services/urlMiner');

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

/**
 * Pagination helper
 */
function parsePagination(query, defaultLimit = 20, maxLimit = 100) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const rawLimit = parseInt(query.limit, 10);
  const limit = Math.min(Math.max(rawLimit || defaultLimit, 1), maxLimit);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/**
 * Log row mapper
 */
function mapLogRow(row) {
  const ts = row.created_at || row.log_ts || row.timestamp || null;
  const timestamp = ts
    ? (ts instanceof Date ? ts.toISOString() : new Date(ts).toISOString())
    : null;

  const meta = row.meta || row.details || null;

  return {
    id: row.id,
    job_id: row.job_id,
    timestamp,
    level: row.level || 'info',
    message: row.message || '',
    meta,
    // front-end "details" bekliyorsa diye aynı veriyi burada da tutuyoruz
    details: meta
  };
}

/**
 * Auth middleware
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

    // Bazı kodlar req.user bekliyor olabilir, uyumluluk için:
    req.user = req.auth;

    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * UUID validation helper
 */
function isValidUuid(id) {
  if (!id || typeof id !== 'string') return false;
  // Standard UUID v4 format: 8-4-4-4-12 hex characters
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
}

/**
 * Middleware to validate job ID parameter
 */
function validateJobId(req, res, next) {
  const jobId = req.params.id;

  // Check for common invalid values
  if (!jobId || jobId === 'undefined' || jobId === 'null' || !isValidUuid(jobId)) {
    return res.status(400).json({
      error: "Invalid job ID format",
      details: `Job ID must be a valid UUID, received: ${jobId}`
    });
  }

  next();
}

/**
 * Helper: Start a mining job asynchronously (fire-and-forget)
 * Bu, API cevabını bekletmeden job'ı arka planda çalıştırır
 */
function queueJobForProcessing(job_id, organizer_id, job_type) {
  // Şu an sadece URL mining otomatik başlatılıyor
  if (job_type !== 'url') {
    console.log(
      `[MiningJobs] Auto-start skipped for job ${job_id}: unsupported type '${job_type}'`
    );
    return;
  }

  console.log(`[MiningJobs] Queueing job ${job_id} for processing...`);

  // Fire-and-forget: API cevabını bekletmeden arka planda çalıştır
  setImmediate(async () => {
    try {
      // Job hâlâ var mı ve durumu uygun mu?
      const jobRes = await db.query(
        `SELECT * FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
        [job_id, organizer_id]
      );

      if (jobRes.rows.length === 0) {
        console.warn(`[MiningJobs] Job ${job_id} not found when auto-starting, skipping`);
        return;
      }

      const job = jobRes.rows[0];

      if (job.status === 'running') {
        console.log(`[MiningJobs] Job ${job_id} already running, skipping auto-start`);
        return;
      }

      if (['completed', 'cancelled'].includes(job.status)) {
        console.log(
          `[MiningJobs] Job ${job_id} has status '${job.status}', skipping auto-start`
        );
        return;
      }

      // Durumu running'e çek
      await db.query(
        `UPDATE mining_jobs
         SET status = 'running',
             started_at = COALESCE(started_at, NOW()),
             updated_at = NOW()
         WHERE id = $1 AND organizer_id = $2`,
        [job_id, organizer_id]
      );

      // Asıl mining işlemini çalıştır
      await runUrlMiningJob(job_id, organizer_id);

    } catch (err) {
      console.error(`[MiningJobs] Auto-start error for job ${job_id}:`, err);

      // Hata durumda job'ı failed yapmaya çalış
      try {
        await db.query(
          `UPDATE mining_jobs
           SET status = 'failed',
               error = $1,
               updated_at = NOW()
           WHERE id = $2 AND organizer_id = $3`,
          [err.message || 'Auto-start error', job_id, organizer_id]
        );
      } catch (dbErr) {
        console.error(
          `[MiningJobs] Failed to update job ${job_id} status after auto-start error:`,
          dbErr
        );
      }
    }
  });
}

/**
 * POST /api/mining/jobs
 * Create a new mining job
 */
router.post('/api/mining/jobs', authRequired, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;
    const { type, input, name, strategy, site_profile, config } = req.body;

    if (!type || !input) {
      return res.status(400).json({
        error: "Missing required fields",
        details: "Both 'type' and 'input' are required"
      });
    }

    const allowedTypes = ['url', 'pdf', 'excel', 'word', 'file', 'other'];
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({
        error: "Invalid type",
        details: `Type must be one of: ${allowedTypes.join(', ')}`
      });
    }

    const result = await db.query(
      `INSERT INTO mining_jobs
       (organizer_id, type, input, name, strategy, site_profile, config, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING *`,
      [
        organizer_id,
        type,
        input,
        name || `Mining Job ${new Date().toISOString()}`,
        strategy || 'auto',
        site_profile || null,
        config || {}
      ]
    );

    const job = result.rows[0];

    // 🔥 Yeni job'ı otomatik başlat
    queueJobForProcessing(job.id, organizer_id, type);

    return res.json({
      success: true,
      job,
      message: "Job created and queued for processing"
    });

  } catch (err) {
    console.error("POST /mining/jobs error:", err);
    return res.status(500).json({
      error: "Failed to create mining job",
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

/**
 * GET /api/mining/jobs
 * List all jobs for the organizer
 */
router.get('/api/mining/jobs', authRequired, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;
    const { page, limit, offset } = parsePagination(req.query, 20, 100);
    const { search, status } = req.query;

    const where = ['organizer_id = $1'];
    const params = [organizer_id];
    let idx = 2;

    if (status && status !== 'all') {
      where.push(`status = $${idx}`);
      params.push(status);
      idx++;
    }

    if (search) {
      where.push(`(
        name ILIKE $${idx} OR
        input ILIKE $${idx} OR
        CAST(id AS TEXT) ILIKE $${idx}
      )`);
      params.push(`%${search}%`);
      idx++;
    }

    const baseWhere = `WHERE ${where.join(' AND ')}`;

    // Get paginated jobs
    const jobsRes = await db.query(
      `SELECT *
       FROM mining_jobs
       ${baseWhere}
       ORDER BY created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    );

    // Get stats
    const statsRes = await db.query(
      `SELECT
         COUNT(*)::int AS total,
         COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0)::int AS pending,
         COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0)::int AS running,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0)::int AS completed,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::int AS failed,
         COALESCE(SUM(total_emails_raw), 0)::int AS total_emails
       FROM mining_jobs
       WHERE organizer_id = $1`,
      [organizer_id]
    );

    const stats = statsRes.rows[0] || {};

    return res.json({
      jobs: jobsRes.rows,
      total: parseInt(stats.total) || 0,
      page,
      limit,
      stats: {
        total: parseInt(stats.total) || 0,
        pending: parseInt(stats.pending) || 0,
        running: parseInt(stats.running) || 0,
        completed: parseInt(stats.completed) || 0,
        failed: parseInt(stats.failed) || 0,
        total_emails: parseInt(stats.total_emails) || 0
      }
    });

  } catch (err) {
    console.error("GET /mining/jobs error:", err);
    return res.status(500).json({
      error: "Failed to fetch mining jobs",
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

/**
 * GET /api/mining/jobs/:id
 * Get a single job by ID
 */
router.get('/api/mining/jobs/:id', authRequired, validateJobId, async (req, res) => {
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
      return res.status(404).json({
        error: "Job not found",
        details: `No job found with ID: ${job_id}`
      });
    }

    return res.json({
      job: result.rows[0]
    });

  } catch (err) {
    console.error("GET /mining/jobs/:id error:", err);

    // Handle PostgreSQL invalid UUID error specifically
    if (err.message && err.message.includes('invalid input syntax for type uuid')) {
      return res.status(400).json({
        error: "Invalid job ID format",
        details: "Job ID must be a valid UUID"
      });
    }

    return res.status(500).json({
      error: "Failed to fetch job",
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

/**
 * PATCH /api/mining/jobs/:id
 * Update a job
 */
router.patch('/api/mining/jobs/:id', authRequired, validateJobId, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;
    const job_id = req.params.id;

    const allowedFields = [
      'name',
      'notes',
      'status',
      'progress',
      'processed_pages',
      'total_pages',
      'input',
      'type',
      'strategy',
      'site_profile',
      'config',
      'stats',
      'total_found',
      'total_prospects_created',
      'total_emails_raw',
      'error',
      'started_at',
      'completed_at'
    ];

    const updates = {};
    let hasUpdates = false;

    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        updates[field] = req.body[field];
        hasUpdates = true;
      }
    }

    if (!hasUpdates) {
      return res.status(400).json({
        error: "No valid fields to update",
        details: `Allowed fields: ${allowedFields.join(', ')}`
      });
    }

    // Build dynamic UPDATE query
    const setClause = Object.keys(updates)
      .map((field, idx) => `${field} = $${idx + 3}`)
      .join(', ');

    const values = [job_id, organizer_id, ...Object.values(updates)];

    const result = await db.query(
      `UPDATE mining_jobs
       SET ${setClause}, updated_at = NOW()
       WHERE id = $1 AND organizer_id = $2
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Job not found",
        details: `No job found with ID: ${job_id}`
      });
    }

    return res.json({
      job: result.rows[0]
    });

  } catch (err) {
    console.error("PATCH /mining/jobs/:id error:", err);
    return res.status(500).json({
      error: "Failed to update job",
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

/**
 * DELETE /api/mining/jobs/:id
 * Soft delete a job (mark as cancelled)
 */
router.delete('/api/mining/jobs/:id', authRequired, validateJobId, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;
    const job_id = req.params.id;

    const result = await db.query(
      `UPDATE mining_jobs
       SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND organizer_id = $2
       RETURNING *`,
      [job_id, organizer_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Job not found",
        details: `No job found with ID: ${job_id}`
      });
    }

    return res.json({
      job: result.rows[0],
      deleted: true
    });

  } catch (err) {
    console.error("DELETE /mining/jobs/:id error:", err);
    return res.status(500).json({
      error: "Failed to delete job",
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

/**
 * POST /api/mining/jobs/:id/retry
 * Create a new job with same configuration
 */
router.post('/api/mining/jobs/:id/retry', authRequired, validateJobId, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;
    const job_id = req.params.id;

    const jobRes = await db.query(
      `SELECT * FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
      [job_id, organizer_id]
    );

    if (jobRes.rows.length === 0) {
      return res.status(404).json({
        error: "Job not found",
        details: `No job found with ID: ${job_id}`
      });
    }

    const originalJob = jobRes.rows[0];

    const newJobRes = await db.query(
      `INSERT INTO mining_jobs
       (organizer_id, type, input, name, strategy, site_profile, config, status, parent_job_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
       RETURNING *`,
      [
        organizer_id,
        originalJob.type,
        originalJob.input,
        `${originalJob.name} (Retry)`,
        originalJob.strategy,
        originalJob.site_profile,
        originalJob.config,
        job_id
      ]
    );

    const newJob = newJobRes.rows[0];

    // Update original job with retry reference
    await db.query(
      `UPDATE mining_jobs SET retry_job_id = $1 WHERE id = $2`,
      [newJob.id, job_id]
    );

    // 🔥 Retry job'ı da otomatik başlat
    queueJobForProcessing(newJob.id, organizer_id, originalJob.type);

    return res.json({
      new_job_id: newJob.id,
      job: newJob,
      message: "Retry job created and queued for processing"
    });

  } catch (err) {
    console.error("POST /mining/jobs/:id/retry error:", err);
    return res.status(500).json({
      error: "Failed to retry job",
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

/**
 * Helper function to update job status
 */
async function updateJobStatus(job_id, organizer_id, status) {
  const validStatuses = ['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'];

  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }

  const result = await db.query(
    `UPDATE mining_jobs
     SET status = $1, updated_at = NOW()
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

/**
 * POST /api/mining/jobs/:id/pause
 */
router.post('/api/mining/jobs/:id/pause', authRequired, validateJobId, async (req, res) => {
  try {
    const job = await updateJobStatus(req.params.id, req.auth.organizer_id, 'paused');
    return res.json({ job });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({
        error: "Job not found",
        details: `No job found with ID: ${req.params.id}`
      });
    }
    console.error("POST /mining/jobs/:id/pause error:", err);
    return res.status(500).json({
      error: "Failed to pause job",
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

/**
 * POST /api/mining/jobs/:id/resume
 */
router.post('/api/mining/jobs/:id/resume', authRequired, validateJobId, async (req, res) => {
  try {
    const job = await updateJobStatus(req.params.id, req.auth.organizer_id, 'running');
    return res.json({ job });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({
        error: "Job not found",
        details: `No job found with ID: ${req.params.id}`
      });
    }
    console.error("POST /mining/jobs/:id/resume error:", err);
    return res.status(500).json({
      error: "Failed to resume job",
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

/**
 * POST /api/mining/jobs/:id/cancel
 */
router.post('/api/mining/jobs/:id/cancel', authRequired, validateJobId, async (req, res) => {
  try {
    const job = await updateJobStatus(req.params.id, req.auth.organizer_id, 'cancelled');
    return res.json({ job });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({
        error: "Job not found",
        details: `No job found with ID: ${req.params.id}`
      });
    }
    console.error("POST /mining/jobs/:id/cancel error:", err);
    return res.status(500).json({
      error: "Failed to cancel job",
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

/**
 * GET /api/mining/jobs/:id/logs
 * Fetch logs from mining_job_logs table
 */
router.get('/api/mining/jobs/:id/logs', authRequired, validateJobId, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;
    const job_id = req.params.id;

    // Önce job gerçekten bu organizere ait mi kontrol et
    const jobRes = await db.query(
      `SELECT id, status
       FROM mining_jobs
       WHERE id = $1 AND organizer_id = $2`,
      [job_id, organizer_id]
    );

    if (jobRes.rows.length === 0) {
      return res.status(404).json({
        error: "Job not found",
        details: `No job found with ID: ${job_id}`
      });
    }

    const job = jobRes.rows[0];

    const logsRes = await db.query(
      `SELECT id, job_id, level, message, meta, created_at
       FROM mining_job_logs
       WHERE job_id = $1
       ORDER BY created_at ASC`,
      [job_id]
    );

    const logs = logsRes.rows.map(mapLogRow);

    return res.json({
      logs,
      job_id,
      job_status: job.status,
      count: logs.length
    });

  } catch (err) {
    console.error("GET /mining/jobs/:id/logs error:", err);
    return res.status(500).json({
      error: "Failed to fetch logs",
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

/**
 * POST /api/mining/jobs/:id/run
 * Start/trigger the mining job execution (manual trigger)
 */
router.post('/api/mining/jobs/:id/run', authRequired, validateJobId, async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;
    const job_id = req.params.id;

    // Load and validate job
    const jobRes = await db.query(
      `SELECT * FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
      [job_id, organizer_id]
    );

    if (jobRes.rows.length === 0) {
      return res.status(404).json({
        error: "Job not found",
        details: `No job found with ID: ${job_id}`
      });
    }

    const job = jobRes.rows[0];

    // Check job status
    if (job.status === 'running') {
      return res.status(400).json({
        error: "Job already running",
        details: "Cannot start a job that is already running"
      });
    }

    if (job.status === 'completed') {
      return res.status(400).json({
        error: "Job already completed",
        details: "Use retry to run this job again"
      });
    }

    // Update job status to running
    await db.query(
      `UPDATE mining_jobs
       SET status = 'running', started_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [job_id]
    );

    // Execute based on job type
    let result;
    if (job.type === 'url') {
      try {
        result = await runUrlMiningJob(job_id, organizer_id);
      } catch (runErr) {
        // If job execution fails, update status to failed
        await db.query(
          `UPDATE mining_jobs
           SET status = 'failed', error = $1, updated_at = NOW()
           WHERE id = $2`,
          [runErr.message, job_id]
        );
        throw runErr;
      }
    } else {
      return res.status(400).json({
        error: "Not implemented",
        details: `Mining type '${job.type}' is not implemented yet`
      });
    }

    return res.json(result);

  } catch (err) {
    console.error("POST /mining/jobs/:id/run error:", err);
    return res.status(500).json({
      error: "Failed to run job",
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

module.exports = router;
