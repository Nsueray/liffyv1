// backend/routes/miningJobs.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');
const { runUrlMiningJob } = require('../services/urlMiner');

const JWT_SECRET = process.env.JWT_SECRET || 'liffy_secret_key_change_me';

/**
 * Auth middleware
 */
function authRequired(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing Authorization header' });
    }

    const token = authHeader.replace('Bearer ', '').trim();
    const payload = jwt.verify(token, JWT_SECRET);

    req.auth = {
      user_id: payload.user_id,
      organizer_id: payload.organizer_id,
      role: payload.role,
    };

    // Bazı eski kodlar req.user bekliyor olabilir
    req.user = req.auth;

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * UUID validation helper
 */
function isValidUuid(id) {
  if (!id || typeof id !== 'string') return false;
  // 8-4-4-4-12 hex
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
}

/**
 * Middleware to validate job ID parameter
 */
function validateJobId(req, res, next) {
  const jobId = req.params.id;

  if (!jobId || jobId === 'undefined' || jobId === 'null' || !isValidUuid(jobId)) {
    return res.status(400).json({
      error: 'Invalid job ID format',
      details: `Job ID must be a valid UUID, received: ${jobId}`,
    });
  }

  next();
}

/**
 * Helper: Start a mining job asynchronously (fire-and-forget)
 *
 * ÖNEMLİ:
 *  - Sadece type === 'url' VE strategy === 'http' ise urlMiner çalıştırılır.
 *  - Diğer tüm stratejiler (auto / playwright / vb.) için hiçbir şey yapılmaz,
 *    bu işler eskisi gibi external miningWorker.js tarafından işlenir.
 */
function queueJobForProcessing(jobId, organizerId, jobType, jobStrategy) {
  const normalizedStrategy = (jobStrategy || 'auto').toLowerCase();

  // Şu an sadece URL mining destekliyoruz
  if (jobType !== 'url') {
    console.log(
      `[MiningJobs] Auto-start skipped for job ${jobId}: unsupported type '${jobType}'`
    );
    return;
  }

  // Sadece strategy === http olduğunda basit HTTP miner'ı çalıştır
  if (normalizedStrategy !== 'http') {
    console.log(
      `[MiningJobs] Auto-start skipped for job ${jobId}: strategy='${jobStrategy || 'auto'}'` +
        ` (only 'http' is handled by urlMiner; other strategies are for miningWorker.js)`
    );
    return;
  }

  console.log(
    `[MiningJobs] Queueing job ${jobId} for processing with urlMiner (strategy=http)...`
  );

  // Fire-and-forget
  setImmediate(async () => {
    try {
      // Job hâlâ pending/failed ise running yap
      await db.query(
        `UPDATE mining_jobs
         SET status = 'running',
             started_at = COALESCE(started_at, NOW())
         WHERE id = $1 AND organizer_id = $2
           AND status IN ('pending', 'failed')`,
        [jobId, organizerId]
      );

      // Basit URL miner; kendi içinde status/completed vs update ediyor
      await runUrlMiningJob(jobId, organizerId);

      console.log(
        `[MiningJobs] Job ${jobId} finished by urlMiner (check mining_jobs row for final status)`
      );
    } catch (err) {
      console.error(
        `[MiningJobs] Auto-start error for job ${jobId}:`,
        err && err.message ? err.message : err
      );

      // Best effort: job'u failed olarak işaretle
      try {
        await db.query(
          `UPDATE mining_jobs
           SET status = 'failed',
               error  = $1
           WHERE id = $2`,
          [err.message || 'Auto-start failed', jobId]
        );
      } catch (dbErr) {
        console.error(
          `[MiningJobs] Failed to update job ${jobId} after auto-start error:`,
          dbErr && dbErr.message ? dbErr.message : dbErr
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
        error: 'Missing required fields',
        details: "Both 'type' and 'input' are required",
      });
    }

    const allowedTypes = ['url', 'pdf', 'excel', 'word', 'file', 'other'];
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({
        error: 'Invalid type',
        details: `Type must be one of: ${allowedTypes.join(', ')}`,
      });
    }

    const finalStrategy = strategy || 'auto';

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
        finalStrategy,
        site_profile || null,
        config || {},
      ]
    );

    const job = result.rows[0];

    // 🔥 Auto-start: sadece strategy=http ise job'ı arka planda başlat
    queueJobForProcessing(job.id, organizer_id, type, finalStrategy);

    return res.json({
      success: true,
      job,
    });
  } catch (err) {
    console.error('POST /mining/jobs error:', err);
    return res.status(500).json({
      error: 'Failed to create mining job',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
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
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;
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

    const jobsRes = await db.query(
      `SELECT *
       FROM mining_jobs
       ${baseWhere}
       ORDER BY created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    );

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
        total_emails: parseInt(stats.total_emails) || 0,
      },
    });
  } catch (err) {
    console.error('GET /mining/jobs error:', err);
    return res.status(500).json({
      error: 'Failed to fetch mining jobs',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
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
        error: 'Job not found',
        details: `No job found with ID: ${job_id}`,
      });
    }

    return res.json({
      job: result.rows[0],
    });
  } catch (err) {
    console.error('GET /mining/jobs/:id error:', err);

    if (err.message && err.message.includes('invalid input syntax for type uuid')) {
      return res.status(400).json({
        error: 'Invalid job ID format',
        details: 'Job ID must be a valid UUID',
      });
    }

    return res.status(500).json({
      error: 'Failed to fetch job',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
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
      'completed_at',
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
        error: 'No valid fields to update',
        details: `Allowed fields: ${allowedFields.join(', ')}`,
      });
    }

    const setClause = Object.keys(updates)
      .map((field, idx) => `${field} = $${idx + 3}`)
      .join(', ');

    const values = [job_id, organizer_id, ...Object.values(updates)];

    const result = await db.query(
      `UPDATE mining_jobs
       SET ${setClause}
       WHERE id = $1 AND organizer_id = $2
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Job not found',
        details: `No job found with ID: ${job_id}`,
      });
    }

    return res.json({
      job: result.rows[0],
    });
  } catch (err) {
    console.error('PATCH /mining/jobs/:id error:', err);
    return res.status(500).json({
      error: 'Failed to update job',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
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
       SET status = 'cancelled'
       WHERE id = $1 AND organizer_id = $2
       RETURNING *`,
      [job_id, organizer_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Job not found',
        details: `No job found with ID: ${job_id}`,
      });
    }

    return res.json({
      job: result.rows[0],
      deleted: true,
    });
  } catch (err) {
    console.error('DELETE /mining/jobs/:id error:', err);
    return res.status(500).json({
      error: 'Failed to delete job',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});

/**
 * POST /api/mining/jobs/:id/retry
 * Create a new job with same configuration
 */
router.post(
  '/api/mining/jobs/:id/retry',
  authRequired,
  validateJobId,
  async (req, res) => {
    try {
      const organizer_id = req.auth.organizer_id;
      const job_id = req.params.id;

      const jobRes = await db.query(
        `SELECT * FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
        [job_id, organizer_id]
      );

      if (jobRes.rows.length === 0) {
        return res.status(404).json({
          error: 'Job not found',
          details: `No job found with ID: ${job_id}`,
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
          originalJob.strategy || 'auto',
          originalJob.site_profile,
          originalJob.config,
          job_id,
        ]
      );

      const newJob = newJobRes.rows[0];

      await db.query(
        `UPDATE mining_jobs SET retry_job_id = $1 WHERE id = $2`,
        [newJob.id, job_id]
      );

      // 🔥 Auto-start retry job (sadece strategy=http ise)
      queueJobForProcessing(
        newJob.id,
        organizer_id,
        newJob.type,
        newJob.strategy || 'auto'
      );

      return res.json({
        new_job_id: newJob.id,
        job: newJob,
      });
    } catch (err) {
      console.error('POST /mining/jobs/:id/retry error:', err);
      return res.status(500).json({
        error: 'Failed to retry job',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined,
      });
    }
  }
);

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

/**
 * POST /api/mining/jobs/:id/pause
 */
router.post(
  '/api/mining/jobs/:id/pause',
  authRequired,
  validateJobId,
  async (req, res) => {
    try {
      const job = await updateJobStatus(
        req.params.id,
        req.auth.organizer_id,
        'paused'
      );
      return res.json({ job });
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({
          error: 'Job not found',
          details: `No job found with ID: ${req.params.id}`,
        });
      }
      console.error('POST /mining/jobs/:id/pause error:', err);
      return res.status(500).json({
        error: 'Failed to pause job',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined,
      });
    }
  }
);

/**
 * POST /api/mining/jobs/:id/resume
 */
router.post(
  '/api/mining/jobs/:id/resume',
  authRequired,
  validateJobId,
  async (req, res) => {
    try {
      const job = await updateJobStatus(
        req.params.id,
        req.auth.organizer_id,
        'running'
      );
      return res.json({ job });
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({
          error: 'Job not found',
          details: `No job found with ID: ${req.params.id}`,
        });
      }
      console.error('POST /mining/jobs/:id/resume error:', err);
      return res.status(500).json({
        error: 'Failed to resume job',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined,
      });
    }
  }
);

/**
 * POST /api/mining/jobs/:id/cancel
 */
router.post(
  '/api/mining/jobs/:id/cancel',
  authRequired,
  validateJobId,
  async (req, res) => {
    try {
      const job = await updateJobStatus(
        req.params.id,
        req.auth.organizer_id,
        'cancelled'
      );
      return res.json({ job });
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({
          error: 'Job not found',
          details: `No job found with ID: ${req.params.id}`,
        });
      }
      console.error('POST /mining/jobs/:id/cancel error:', err);
      return res.status(500).json({
        error: 'Failed to cancel job',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined,
      });
    }
  }
);

/**
 * GET /api/mining/jobs/:id/logs
 * Mevcut mining_job_logs tablosunu okur.
 * DB'de ekstra kolonlar varsa otomatik gelir; meta zorunlu değil.
 */
router.get(
  '/api/mining/jobs/:id/logs',
  authRequired,
  validateJobId,
  async (req, res) => {
    try {
      const organizer_id = req.auth.organizer_id;
      const job_id = req.params.id;

      // Job gerçekten sana mı ait, kontrol et
      const jobRes = await db.query(
        `SELECT id FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
        [job_id, organizer_id]
      );

      if (jobRes.rows.length === 0) {
        return res.status(404).json({
          error: 'Job not found',
          details: `No job found with ID: ${job_id}`,
        });
      }

      let logs = [];
      try {
        const logsRes = await db.query(
          `SELECT * 
           FROM mining_job_logs
           WHERE job_id = $1
           ORDER BY created_at ASC
           LIMIT 500`,
          [job_id]
        );

        logs = logsRes.rows.map((row) => ({
          id: row.id,
          job_id: row.job_id,
          timestamp: row.created_at,
          level: row.level || 'info',
          message: row.message || '',
          meta: row.meta || null, // meta kolonu yoksa undefined olur, sorun değil
        }));
      } catch (logErr) {
        // Tablo yoksa vs. hata verirse, UI'ya boş liste dönelim (eski davranış)
        console.error('GET /mining/jobs/:id/logs db error:', logErr.message);
        logs = [];
      }

      return res.json({
        logs,
        job_id,
      });
    } catch (err) {
      console.error('GET /mining/jobs/:id/logs error:', err);
      return res.status(500).json({
        error: 'Failed to fetch logs',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined,
      });
    }
  }
);

/**
 * POST /api/mining/jobs/:id/run
 * Manual start/trigger
 *
 * Burada da sadece strategy=http ise urlMiner çalışır.
 * Diğer stratejiler için 400 döner ve miningWorker.js kullanman gerektiğini söyler.
 */
router.post(
  '/api/mining/jobs/:id/run',
  authRequired,
  validateJobId,
  async (req, res) => {
    try {
      const organizer_id = req.auth.organizer_id;
      const job_id = req.params.id;

      const jobRes = await db.query(
        `SELECT * FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
        [job_id, organizer_id]
      );

      if (jobRes.rows.length === 0) {
        return res.status(404).json({
          error: 'Job not found',
          details: `No job found with ID: ${job_id}`,
        });
      }

      const job = jobRes.rows[0];
      const strategy = (job.strategy || 'auto').toLowerCase();

      if (job.status === 'running') {
        return res.status(400).json({
          error: 'Job already running',
          details: 'Cannot start a job that is already running',
        });
      }

      if (job.status === 'completed') {
        return res.status(400).json({
          error: 'Job already completed',
          details: 'Use retry to run this job again',
        });
      }

      // Eğer strategy http değilse, bu iş Playwright/miningWorker içindir
      if (job.type === 'url' && strategy !== 'http') {
        return res.status(400).json({
          error: 'Job is configured for miningWorker (Playwright)',
          details:
            "This job does not use the simple HTTP miner. Run it via miningWorker.js " +
            "or create a new job with strategy='http' to use the built-in urlMiner.",
        });
      }

      // burada da updated_at kullanmıyoruz
      await db.query(
        `UPDATE mining_jobs 
         SET status = 'running', started_at = NOW()
         WHERE id = $1`,
        [job_id]
      );

      let result;
      if (job.type === 'url' && strategy === 'http') {
        try {
          result = await runUrlMiningJob(job_id, organizer_id);
        } catch (runErr) {
          await db.query(
            `UPDATE mining_jobs 
             SET status = 'failed', error = $1
             WHERE id = $2`,
            [runErr.message, job_id]
          );
          throw runErr;
        }
      } else {
        return res.status(400).json({
          error: 'Not implemented',
          details: `Mining type '${job.type}' is not implemented yet`,
        });
      }

      return res.json(result);
    } catch (err) {
      console.error('POST /mining/jobs/:id/run error:', err);
      return res.status(500).json({
        error: 'Failed to run job',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined,
      });
    }
  }
);

module.exports = router;
