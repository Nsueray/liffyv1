// backend/routes/miningJobs.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const JWT_SECRET = process.env.JWT_SECRET || 'liffy_secret_key_change_me';

// --- MULTER AYARLARI (MEMORY STORAGE) ---
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB Limit
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
 * Helper: Convert Buffer to PostgreSQL bytea hex format
 * Bu fonksiyon binary veriyi güvenli bir şekilde PostgreSQL'e kaydeder
 */
function bufferToByteaHex(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) return null;
  // PostgreSQL bytea hex format: \x followed by hex string
  return '\\x' + buffer.toString('hex');
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
    let fileHex = null;

    // Dosya Yüklendiyse (Multipart)
    if (req.file) {
        console.log(`📁 File upload received: ${req.file.originalname}`);
        console.log(`   Original size: ${req.file.size} bytes`);
        console.log(`   Buffer size: ${req.file.buffer.length} bytes`);
        console.log(`   Magic bytes: ${req.file.buffer.slice(0, 4).toString('hex')}`);
        
        type = 'file';
        input = req.file.originalname;
        name = name || req.file.originalname;
        strategy = 'auto';
        fileBuffer = req.file.buffer;
        
        // ÖNEMLİ: Buffer'ı hex string'e çevir - encoding sorununu önler
        fileHex = bufferToByteaHex(fileBuffer);
        
        console.log(`   Hex string length: ${fileHex ? fileHex.length : 0}`);
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

    // DB'ye Kayıt
    // NOT: file_data için raw SQL kullanıyoruz çünkü pg driver bazen buffer'ı yanlış encode ediyor
    let result;
    
    if (fileHex) {
      // Dosya varsa - hex string olarak kaydet
      result = await db.query(
        `INSERT INTO mining_jobs
         (organizer_id, type, input, name, strategy, site_profile, config, status, file_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', decode($8, 'hex'))
         RETURNING id, organizer_id, type, input, name, strategy, site_profile, config, status, created_at`,
        [
          organizer_id,
          type,
          input,
          name || `Mining Job ${new Date().toISOString()}`,
          strategy || 'auto',
          site_profile || null,
          config || {},
          fileHex.slice(2) // Remove '\x' prefix, decode() expects pure hex
        ]
      );
    } else {
      // Dosya yoksa (URL job)
      result = await db.query(
        `INSERT INTO mining_jobs
         (organizer_id, type, input, name, strategy, site_profile, config, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         RETURNING id, organizer_id, type, input, name, strategy, site_profile, config, status, created_at`,
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
    }

    console.log(`✅ Mining job created: ${result.rows[0].id}`);
    
    return res.json({ success: true, job: result.rows[0] });
  } catch (err) {
    console.error('POST /mining/jobs error:', err);
    return res.status(500).json({ error: 'Failed to create mining job', details: err.message });
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

    // ÖNEMLİ: file_data sütununu seçmiyoruz - performans için
    const jobsRes = await db.query(
      `SELECT id, organizer_id, type, input, name, strategy, site_profile, config, status, 
              progress, total_found, total_emails_raw, stats, error, created_at, completed_at,
              manual_required, manual_reason
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

  try {
    // file_data'yı çekmiyoruz - sadece metadata
    const result = await db.query(
      `SELECT id, organizer_id, type, input, name, strategy, site_profile, config, status, 
              progress, total_found, total_emails_raw, stats, error, created_at, completed_at,
              manual_required, manual_reason,
              CASE WHEN file_data IS NOT NULL THEN true ELSE false END as has_file
       FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
      [job_id, organizer_id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Job not found' });
    }

    return res.json({ job: result.rows[0] });
  } catch (err) {
    console.error('GET /mining/jobs/:id error:', err);
    return res.status(500).json({ error: 'Failed to fetch job' });
  }
});

/**
 * PATCH /api/mining/jobs/:id
 */
router.patch('/api/mining/jobs/:id', authRequired, validateJobId, async (req, res) => {
  const { organizer_id } = req.auth;
  const job_id = req.params.id;

  try {
    const updates = req.body || {};
    const keys = Object.keys(updates);
    
    // file_data güncellemesine izin verme
    const allowedKeys = keys.filter(k => k !== 'file_data');
    
    if (!allowedKeys.length) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const setClause = allowedKeys.map((k, i) => `${k} = $${i + 3}`).join(', ');
    const values = [job_id, organizer_id, ...allowedKeys.map(k => updates[k])];

    const result = await db.query(
      `UPDATE mining_jobs SET ${setClause} WHERE id = $1 AND organizer_id = $2 
       RETURNING id, organizer_id, type, input, name, status, config, stats, error`,
      values
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Job not found' });
    }

    return res.json({ job: result.rows[0] });
  } catch (err) {
    console.error('PATCH /mining/jobs/:id error:', err);
    return res.status(500).json({ error: 'Failed to update job' });
  }
});

/**
 * POST /api/mining/jobs/:id/retry
 * Job'u yeniden dener - file_data'yı da kopyalar
 */
router.post('/api/mining/jobs/:id/retry', authRequired, validateJobId, async (req, res) => {
  const organizer_id = req.auth.organizer_id;
  const job_id = req.params.id;

  try {
    // Orijinal job'u al (file_data dahil)
    const jobRes = await db.query(
      `SELECT type, input, name, strategy, site_profile, config, file_data 
       FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
      [job_id, organizer_id]
    );

    if (!jobRes.rows.length) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const j = jobRes.rows[0];

    // Yeni job oluştur
    const newJob = await db.query(
      `INSERT INTO mining_jobs
       (organizer_id, type, input, name, strategy, site_profile, config, status, file_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
       RETURNING id, organizer_id, type, input, name, status`,
      [
        organizer_id,
        j.type,
        j.input,
        `${j.name} (Retry)`,
        j.strategy,
        j.site_profile,
        j.config,
        j.file_data // file_data olduğu gibi kopyalanıyor
      ]
    );

    console.log(`🔄 Retry job created: ${newJob.rows[0].id} from ${job_id}`);
    
    return res.json({ job: newJob.rows[0] });
  } catch (err) {
    console.error('POST /mining/jobs/:id/retry error:', err);
    return res.status(500).json({ error: 'Failed to create retry job' });
  }
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

    // mining_results'lar CASCADE ile silinecek
    await db.query(
      `DELETE FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
      [job_id, organizer_id]
    );

    console.log(`🗑️ Job deleted: ${job_id}`);
    
    return res.json({ success: true, message: 'Job deleted successfully' });
  } catch (err) {
    console.error('DELETE /mining/jobs/:id error:', err);
    return res.status(500).json({ error: 'Failed to delete job' });
  }
});

/**
 * GET /api/mining/jobs/:id/file
 * Job'un dosyasını indir (debugging için)
 */
router.get('/api/mining/jobs/:id/file', authRequired, validateJobId, async (req, res) => {
  const { organizer_id } = req.auth;
  const job_id = req.params.id;

  try {
    const result = await db.query(
      `SELECT input, file_data FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
      [job_id, organizer_id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const job = result.rows[0];
    
    if (!job.file_data) {
      return res.status(404).json({ error: 'No file data available' });
    }

    // Dosya tipini belirle
    const filename = job.input || 'download';
    const ext = filename.split('.').pop().toLowerCase();
    
    const mimeTypes = {
      'pdf': 'application/pdf',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'doc': 'application/msword',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'xls': 'application/vnd.ms-excel',
      'csv': 'text/csv',
      'txt': 'text/plain'
    };
    
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', job.file_data.length);
    
    return res.send(job.file_data);
  } catch (err) {
    console.error('GET /mining/jobs/:id/file error:', err);
    return res.status(500).json({ error: 'Failed to download file' });
  }
});

module.exports = router;
