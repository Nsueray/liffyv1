// backend/routes/miningJobs.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const JWT_SECRET = process.env.JWT_SECRET || 'liffy_secret_key_change_me';

// --- MULTER AYARLARI (MEMORY STORAGE) ---
// Dosyayı diske değil, RAM'e (Buffer) alıyoruz.
// Böylece veritabanına BYTEA olarak kaydedebiliriz.
const storage = multer.memoryStorage();

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB Limit (Güvenlik için)
});

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

    req.user = req.auth;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * UUID validation
 */
function isValidUuid(id) {
  return typeof id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function validateJobId(req, res, next) {
  const jobId = req.params.id;
  if (!isValidUuid(jobId)) {
    return res.status(400).json({
      error: 'Invalid job ID format',
      details: `Job ID must be a valid UUID, received: ${jobId}`,
    });
  }
  next();
}

/**
 * POST /api/mining/jobs
 * Hem JSON (URL) hem Multipart (Dosya) kabul eder
 */
router.post('/api/mining/jobs', authRequired, upload.single('file'), async (req, res) => {
  try {
    const organizer_id = req.auth.organizer_id;
    
    // Body'den verileri al
    let { type, input, name, strategy, site_profile, config } = req.body;
    let fileBuffer = null;

    // Dosya Yüklendiyse (Multipart)
    if (req.file) {
        type = 'file';
        input = req.file.originalname; // Dosya ismini input olarak sakla
        name = name || req.file.originalname;
        strategy = 'auto'; // Dosyalar için her zaman auto
        fileBuffer = req.file.buffer; // Dosyanın binary verisi
    }

    // Validation
    if (!type || (!input && !req.file)) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: "Both 'type' and 'input' (or 'file') are required",
      });
    }

    const allowedTypes = ['url', 'pdf', 'excel', 'word', 'file', 'other'];
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({
        error: 'Invalid type',
        details: `Type must be one of: ${allowedTypes.join(', ')}`,
      });
    }

    // Config form-data içinde string olarak gelebilir, parse et
    if (typeof config === 'string') {
        try { config = JSON.parse(config); } catch(e) { config = {} }
    }

    // DB'ye Kayıt (file_data sütununa buffer'ı ekliyoruz)
    const result = await db.query(
      `INSERT INTO mining_jobs
       (organizer_id, type, input, name, strategy, site_profile, config, status, file_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
       RETURNING id, organizer_id, type, input, name, strategy, site_profile, config, status, created_at`, 
       // Not: file_data'yı RETURNING ile geri döndürmüyoruz, performans için.
      [
        organizer_id,
        type,
        input,
        name || `Mining Job ${new Date().toISOString()}`,
        strategy || 'auto',
        site_profile || null,
        config || {},
        fileBuffer
      ]
    );

    return res.json({ success: true, job: result.rows[0] });
  } catch (err) {
    console.error('POST /mining/jobs error:', err);
    return res.status(500).json({ error: 'Failed to create mining job' });
  }
});

/**
 * GET /api/mining/jobs
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
      where.push(`status = $${idx++}`);
      params.push(status);
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

    // ÖNEMLİ: file_data sütununu bilerek seçmiyoruz (*) kullanmıyoruz.
    // Çünkü listelemede binary dosya verisini çekersek API çok yavaşlar.
    const jobsRes = await db.query(
      `SELECT id, organizer_id, type, input, name, strategy, site_profile, config, status, 
              progress, total_found, total_emails_raw, stats, created_at, completed_at
       FROM mining_jobs
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    );

    const statsRes = await db.query(
      `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'running')::int AS running,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COALESCE(SUM(total_emails_raw), 0)::int AS total_emails
       FROM mining_jobs
       WHERE organizer_id = $1`,
      [organizer_id]
    );

    return res.json({
      jobs: jobsRes.rows,
      page,
      limit,
      stats: statsRes.rows[0],
    });
  } catch (err) {
    console.error('GET /mining/jobs error:', err);
    return res.status(500).json({ error: 'Failed to fetch mining jobs' });
  }
});

/**
 * GET /api/mining/jobs/:id
 */
router.get('/api/mining/jobs/:id', authRequired, validateJobId, async (req, res) => {
  const { organizer_id } = req.auth;
  const job_id = req.params.id;

  // Detayda da file_data'yı çekmiyoruz, gerekirse ayrı endpoint yapılır.
  const result = await db.query(
    `SELECT id, organizer_id, type, input, name, strategy, site_profile, config, status, 
            progress, total_found, total_emails_raw, stats, created_at, completed_at
     FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
    [job_id, organizer_id]
  );

  if (!result.rows.length) {
    return res.status(404).json({ error: 'Job not found' });
  }

  return res.json({ job: result.rows[0] });
});

/**
 * PATCH /api/mining/jobs/:id
 */
router.patch('/api/mining/jobs/:id', authRequired, validateJobId, async (req, res) => {
  const { organizer_id } = req.auth;
  const job_id = req.params.id;

  const updates = req.body || {};
  const keys = Object.keys(updates);
  if (!keys.length) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  const setClause = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
  const values = [job_id, organizer_id, ...Object.values(updates)];

  // file_data hariç dön
  const result = await db.query(
    `UPDATE mining_jobs SET ${setClause} WHERE id = $1 AND organizer_id = $2 
     RETURNING id, organizer_id, type, input, name, status, config, stats`,
    values
  );

  if (!result.rows.length) {
    return res.status(404).json({ error: 'Job not found' });
  }

  return res.json({ job: result.rows[0] });
});

/**
 * POST /api/mining/jobs/:id/retry
 * Create retry job ONLY (worker will pick it up)
 */
router.post('/api/mining/jobs/:id/retry', authRequired, validateJobId, async (req, res) => {
  const organizer_id = req.auth.organizer_id;
  const job_id = req.params.id;

  // Retry için orijinal veriyi (binary file_data dahil) çekmemiz lazım
  const jobRes = await db.query(
    `SELECT * FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
    [job_id, organizer_id]
  );

  if (!jobRes.rows.length) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const j = jobRes.rows[0];

  // Yeni job oluştururken eski binary datayı da kopyalıyoruz
  const newJob = await db.query(
    `INSERT INTO mining_jobs
     (organizer_id, type, input, name, strategy, site_profile, config, status, file_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending', $8)
     RETURNING id, organizer_id, type, input, name, status`,
    [
      organizer_id,
      j.type,
      j.input,
      `${j.name} (Retry)`,
      j.strategy,
      j.site_profile,
      j.config,
      j.file_data // Eski dosya verisi
    ]
  );

  return res.json({ job: newJob.rows[0] });
});

/**
 * DELETE /api/mining/jobs/:id
 */
router.delete('/api/mining/jobs/:id', authRequired, validateJobId, async (req, res) => {
  const { organizer_id } = req.auth;
  const job_id = req.params.id;

  try {
    const checkRes = await db.query(
      `SELECT id FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
      [job_id, organizer_id]
    );

    if (checkRes.rowCount === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Delete job (assuming CASCADE is set up in DB for results)
    await db.query(
      `DELETE FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
      [job_id, organizer_id]
    );

    return res.json({ success: true, message: 'Job deleted successfully' });
  } catch (err) {
    console.error('DELETE /mining/jobs/:id error:', err);
    return res.status(500).json({ error: 'Failed to delete job' });
  }
});

module.exports = router;
