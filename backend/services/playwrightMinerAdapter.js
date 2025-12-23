const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authRequired } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');

// UUID validation helper
function isValidUuid(id) {
  if (!id || typeof id !== 'string') return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
}

// Middleware to validate job ID
function validateJobId(req, res, next) {
  const jobId = req.params.id;
  
  if (!jobId || jobId === 'undefined' || jobId === 'null' || !isValidUuid(jobId)) {
    return res.status(400).json({ 
      error: "Invalid job ID format",
      details: `Job ID must be a valid UUID, received: ${jobId}`
    });
  }
  
  next();
}

// GET /api/mining/jobs - List all jobs for organizer
router.get('/api/mining/jobs', authRequired, async (req, res) => {
  try {
    const organizerId = req.user.organizer_id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = req.query.search || '';
    const status = req.query.status || '';
    const offset = (page - 1) * limit;

    // Build WHERE clause
    let whereConditions = ['organizer_id = $1'];
    let params = [organizerId];
    let paramCount = 1;

    if (search) {
      paramCount++;
      whereConditions.push(`(
        name ILIKE $${paramCount} OR 
        input ILIKE $${paramCount} OR 
        site_profile ILIKE $${paramCount}
      )`);
      params.push(`%${search}%`);
    }

    if (status && status !== 'all') {
      paramCount++;
      whereConditions.push(`status = $${paramCount}`);
      params.push(status);
    }

    const whereClause = whereConditions.join(' AND ');

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM mining_jobs 
      WHERE ${whereClause}
    `;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    // Get paginated jobs
    paramCount++;
    params.push(limit);
    paramCount++;
    params.push(offset);

    const jobsQuery = `
      SELECT 
        id, 
        organizer_id, 
        name,
        type, 
        input, 
        strategy,
        site_profile,
        status, 
        progress,
        total_found, 
        total_emails_raw, 
        total_prospects_created,
        processed_pages,
        total_pages,
        error,
        created_at,
        started_at,
        completed_at,
        updated_at
      FROM mining_jobs
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramCount - 1} OFFSET $${paramCount}
    `;
    
    const jobsResult = await pool.query(jobsQuery, params);

    // Calculate stats
    const statsQuery = `
      SELECT 
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'running') as running,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'failed') as failed,
        COALESCE(SUM(total_emails_raw), 0) as total_emails
      FROM mining_jobs
      WHERE organizer_id = $1
    `;
    const statsResult = await pool.query(statsQuery, [organizerId]);
    const stats = statsResult.rows[0];

    res.json({
      jobs: jobsResult.rows,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit)
      },
      stats: {
        total,
        pending: parseInt(stats.pending) || 0,
        running: parseInt(stats.running) || 0,
        completed: parseInt(stats.completed) || 0,
        failed: parseInt(stats.failed) || 0,
        total_emails: parseInt(stats.total_emails) || 0
      }
    });

  } catch (error) {
    console.error('GET /mining/jobs error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch mining jobs',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// POST /api/mining/jobs - Create new job
router.post('/api/mining/jobs', authRequired, async (req, res) => {
  try {
    const organizerId = req.user.organizer_id;
    const {
      name,
      type,
      input,
      strategy = 'auto',
      site_profile = null,
      config = {}
    } = req.body;

    // Validation
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Job name is required' });
    }

    if (!input || !input.trim()) {
      return res.status(400).json({ error: 'Target URL is required' });
    }

    if (type === 'url' && !input.startsWith('http')) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    const jobId = uuidv4();
    
    // Determine actual strategy
    const actualStrategy = strategy === 'auto' ? 'playwright' : strategy;
    
    // Insert new job
    const insertQuery = `
      INSERT INTO mining_jobs (
        id,
        organizer_id,
        name,
        type,
        input,
        strategy,
        site_profile,
        status,
        config,
        total_found,
        total_emails_raw,
        total_prospects_created,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
      RETURNING *
    `;
    
    const values = [
      jobId,
      organizerId,
      name.trim(),
      type || 'url',
      input.trim(),
      actualStrategy,
      site_profile,
      'pending',
      JSON.stringify(config),
      0,
      0,
      0
    ];

    const result = await pool.query(insertQuery, values);
    const job = result.rows[0];

    // Start mining based on strategy
    if (actualStrategy === 'playwright') {
      // Playwright strategy - start worker directly without API token
      try {
        const workerPath = require('path').join(__dirname, '../services/miningWorker.js');
        const worker = spawn('node', [workerPath], {
          env: {
            ...process.env,
            MINING_JOB_ID: jobId,
            DATABASE_URL: process.env.DATABASE_URL,
            NODE_ENV: process.env.NODE_ENV
            // NO MINING_API_TOKEN needed for playwright
          },
          detached: true,
          stdio: 'ignore'
        });
        
        worker.unref();
        console.log(`Started Playwright mining worker for job ${jobId}`);
        
        // Update job status to queued
        await pool.query(
          'UPDATE mining_jobs SET status = $1 WHERE id = $2',
          ['queued', jobId]
        );
        
      } catch (err) {
        console.error(`Failed to start Playwright worker for job ${jobId}:`, err);
        // Job remains in pending status
      }
      
    } else if (actualStrategy === 'http') {
      // HTTP strategy - may require API token if using external service
      if (process.env.MINING_API_TOKEN) {
        // Start HTTP miner with API
        try {
          const urlMinerPath = require('path').join(__dirname, '../services/urlMiner.js');
          const worker = spawn('node', [urlMinerPath], {
            env: {
              ...process.env,
              MINING_JOB_ID: jobId,
              MINING_API_TOKEN: process.env.MINING_API_TOKEN
            },
            detached: true,
            stdio: 'ignore'
          });
          
          worker.unref();
          console.log(`Started HTTP mining worker for job ${jobId}`);
          
        } catch (err) {
          console.error(`Failed to start HTTP worker for job ${jobId}:`, err);
        }
      } else {
        console.log(`HTTP mining requires MINING_API_TOKEN, job ${jobId} will remain pending`);
      }
    }

    res.status(201).json({
      message: 'Mining job created successfully',
      job: {
        ...job,
        config: typeof job.config === 'string' ? JSON.parse(job.config) : job.config
      }
    });

  } catch (error) {
    console.error('POST /mining/jobs error:', error);
    res.status(500).json({ 
      error: 'Failed to create mining job',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET /api/mining/jobs/:id - Get single job
router.get('/api/mining/jobs/:id', authRequired, validateJobId, async (req, res) => {
  try {
    const jobId = req.params.id;
    const organizerId = req.user.organizer_id;

    const query = `
      SELECT * FROM mining_jobs 
      WHERE id = $1 AND organizer_id = $2
    `;
    
    const result = await pool.query(query, [jobId, organizerId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const job = result.rows[0];
    
    // Parse config if it's a string
    if (job.config && typeof job.config === 'string') {
      try {
        job.config = JSON.parse(job.config);
      } catch (e) {
        job.config = {};
      }
    }

    res.json({ job });

  } catch (error) {
    console.error('GET /mining/jobs/:id error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch job',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// POST /api/mining/jobs/:id/run - Manually start/restart a job
router.post('/api/mining/jobs/:id/run', authRequired, validateJobId, async (req, res) => {
  try {
    const jobId = req.params.id;
    const organizerId = req.user.organizer_id;

    // Get job details
    const jobResult = await pool.query(
      'SELECT * FROM mining_jobs WHERE id = $1 AND organizer_id = $2',
      [jobId, organizerId]
    );
    
    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    const job = jobResult.rows[0];
    
    if (job.status === 'running') {
      return res.status(400).json({ error: 'Job is already running' });
    }
    
    // Reset job status
    await pool.query(
      'UPDATE mining_jobs SET status = $1, error = NULL, started_at = NULL, completed_at = NULL WHERE id = $2',
      ['pending', jobId]
    );
    
    // Start based on strategy
    if (job.strategy === 'playwright' || job.strategy === 'auto') {
      // Playwright - no token needed
      const workerPath = require('path').join(__dirname, '../services/miningWorker.js');
      const worker = spawn('node', [workerPath], {
        env: {
          ...process.env,
          MINING_JOB_ID: jobId,
          DATABASE_URL: process.env.DATABASE_URL,
          NODE_ENV: process.env.NODE_ENV
        },
        detached: true,
        stdio: 'ignore'
      });
      
      worker.unref();
      
      await pool.query(
        'UPDATE mining_jobs SET status = $1 WHERE id = $2',
        ['queued', jobId]
      );
      
      res.json({ message: 'Job started successfully', jobId });
      
    } else if (job.strategy === 'http') {
      // HTTP - may need token
      if (process.env.MINING_API_TOKEN) {
        const urlMinerPath = require('path').join(__dirname, '../services/urlMiner.js');
        const worker = spawn('node', [urlMinerPath], {
          env: {
            ...process.env,
            MINING_JOB_ID: jobId,
            MINING_API_TOKEN: process.env.MINING_API_TOKEN
          },
          detached: true,
          stdio: 'ignore'
        });
        
        worker.unref();
        res.json({ message: 'HTTP mining job started', jobId });
      } else {
        res.status(400).json({ error: 'HTTP mining requires MINING_API_TOKEN environment variable' });
      }
    } else {
      res.status(400).json({ error: `Unknown strategy: ${job.strategy}` });
    }

  } catch (error) {
    console.error('POST /mining/jobs/:id/run error:', error);
    res.status(500).json({ 
      error: 'Failed to start job',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// PATCH /api/mining/jobs/:id - Update job
router.patch('/api/mining/jobs/:id', authRequired, validateJobId, async (req, res) => {
  try {
    const jobId = req.params.id;
    const organizerId = req.user.organizer_id;
    const updates = req.body;

    // Build dynamic UPDATE query
    const allowedFields = ['notes', 'status', 'progress', 'processed_pages', 'total_pages'];
    const updateFields = [];
    const values = [];
    let paramCount = 1;

    for (const field of allowedFields) {
      if (field in updates) {
        updateFields.push(`${field} = $${paramCount}`);
        values.push(updates[field]);
        paramCount++;
      }
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Add jobId and organizerId to params
    values.push(jobId, organizerId);
    
    const query = `
      UPDATE mining_jobs 
      SET ${updateFields.join(', ')}, updated_at = NOW()
      WHERE id = $${paramCount} AND organizer_id = $${paramCount + 1}
      RETURNING *
    `;

    const result = await pool.query(query, values);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.json({ job: result.rows[0] });

  } catch (error) {
    console.error('PATCH /mining/jobs/:id error:', error);
    res.status(500).json({ 
      error: 'Failed to update job',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// DELETE /api/mining/jobs/:id - Delete job
router.delete('/api/mining/jobs/:id', authRequired, validateJobId, async (req, res) => {
  try {
    const jobId = req.params.id;
    const organizerId = req.user.organizer_id;

    // Check if job is running
    const checkQuery = `
      SELECT status FROM mining_jobs 
      WHERE id = $1 AND organizer_id = $2
    `;
    const checkResult = await pool.query(checkQuery, [jobId, organizerId]);
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (checkResult.rows[0].status === 'running') {
      return res.status(400).json({ error: 'Cannot delete a running job' });
    }

    // Delete related results first
    await pool.query('DELETE FROM mining_results WHERE job_id = $1', [jobId]);
    
    // Delete job
    const deleteQuery = `
      DELETE FROM mining_jobs 
      WHERE id = $1 AND organizer_id = $2
    `;
    await pool.query(deleteQuery, [jobId, organizerId]);

    res.json({ message: 'Job deleted successfully' });

  } catch (error) {
    console.error('DELETE /mining/jobs/:id error:', error);
    res.status(500).json({ 
      error: 'Failed to delete job',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// POST /api/mining/jobs/:id/retry - Retry a failed/completed job
router.post('/api/mining/jobs/:id/retry', authRequired, validateJobId, async (req, res) => {
  try {
    const jobId = req.params.id;
    const organizerId = req.user.organizer_id;

    // Get original job
    const originalQuery = `
      SELECT * FROM mining_jobs 
      WHERE id = $1 AND organizer_id = $2
    `;
    const originalResult = await pool.query(originalQuery, [jobId, organizerId]);
    
    if (originalResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const originalJob = originalResult.rows[0];
    
    // Create new job with same config
    const newJobId = uuidv4();
    
    const insertQuery = `
      INSERT INTO mining_jobs (
        id,
        organizer_id,
        name,
        type,
        input,
        strategy,
        site_profile,
        status,
        config,
        parent_job_id,
        total_found,
        total_emails_raw,
        total_prospects_created,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
      RETURNING *
    `;
    
    const values = [
      newJobId,
      organizerId,
      `${originalJob.name} (Retry)`,
      originalJob.type,
      originalJob.input,
      originalJob.strategy,
      originalJob.site_profile,
      'pending',
      originalJob.config,
      jobId, // parent_job_id
      0,
      0,
      0
    ];

    const newJobResult = await pool.query(insertQuery, values);
    const newJob = newJobResult.rows[0];
    
    // Update original job with retry_job_id
    await pool.query(
      'UPDATE mining_jobs SET retry_job_id = $1 WHERE id = $2',
      [newJobId, jobId]
    );
    
    // Auto-start if playwright
    if (newJob.strategy === 'playwright' || newJob.strategy === 'auto') {
      const workerPath = require('path').join(__dirname, '../services/miningWorker.js');
      const worker = spawn('node', [workerPath], {
        env: {
          ...process.env,
          MINING_JOB_ID: newJobId,
          DATABASE_URL: process.env.DATABASE_URL,
          NODE_ENV: process.env.NODE_ENV
        },
        detached: true,
        stdio: 'ignore'
      });
      
      worker.unref();
      
      await pool.query(
        'UPDATE mining_jobs SET status = $1 WHERE id = $2',
        ['queued', newJobId]
      );
    }

    res.json({
      message: 'Retry job created successfully',
      new_job_id: newJobId,
      job: newJob
    });

  } catch (error) {
    console.error('POST /mining/jobs/:id/retry error:', error);
    res.status(500).json({ 
      error: 'Failed to retry job',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = {
  PlaywrightMinerAdapter
};
