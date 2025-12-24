// backend/worker.js
/**
 * Production Background Worker for Mining Jobs
 * Render Background Worker compatible
 */

const db = require('./db');
const { runUrlMiningJob } = require('./services/urlMiner');
const { spawn } = require('child_process');
const path = require('path');

const POLL_INTERVAL_MS = 5000;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;
const STALE_JOB_THRESHOLD_MS = 60 * 60 * 1000;

let isShuttingDown = false;
let currentJobId = null;
let currentJobProcess = null;

async function runWorker() {
  console.log('🚀 Mining Worker started');
  setupShutdownHandlers();
  await cleanupStaleJobs();

  while (!isShuttingDown) {
    try {
      await processNextJob();
    } catch (err) {
      console.error('❌ Worker loop error:', err.message);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function processNextJob() {
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const res = await client.query(`
      SELECT * FROM mining_jobs
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);

    if (!res.rows.length) {
      await client.query('COMMIT');
      return;
    }

    const job = res.rows[0];
    currentJobId = job.id;

    await client.query(
      `UPDATE mining_jobs
       SET status='running', started_at=NOW(), error=NULL
       WHERE id=$1`,
      [job.id]
    );

    await client.query('COMMIT');

    await executeJob(job);

  } catch (err) {
    await client.query('ROLLBACK');
    if (currentJobId) {
      await markJobFailed(currentJobId, err.message);
    }
  } finally {
    client.release();
    currentJobId = null;
    currentJobProcess = null;
  }
}

async function executeJob(job) {
  const timeout = new Promise((_, r) =>
    setTimeout(() => r(new Error('Job timeout exceeded')), JOB_TIMEOUT_MS)
  );

  try {
    if (job.type !== 'url') {
      throw new Error(`Unsupported job type: ${job.type}`);
    }

    const exec =
      job.strategy === 'playwright' || job.strategy === 'auto'
        ? executePlaywrightJob(job)
        : runUrlMiningJob(job.id, job.organizer_id);

    await Promise.race([exec, timeout]);
    await markJobCompleted(job.id);

  } catch (err) {
    if (currentJobProcess) {
      try { process.kill(currentJobProcess.pid); } catch {}
    }
    await markJobFailed(job.id, err.message);
  }
}

function executePlaywrightJob(job) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'services', 'miningWorker.js');

    currentJobProcess = spawn('node', [workerPath], {
      env: {
        ...process.env,
        MINING_JOB_ID: job.id,
      },
      stdio: 'inherit',
    });

    currentJobProcess.on('exit', (code) => {
      currentJobProcess = null;
      code === 0 ? resolve() : reject(new Error(`Worker exit ${code}`));
    });

    currentJobProcess.on('error', reject);
  });
}

async function markJobCompleted(jobId) {
  await db.query(
    `UPDATE mining_jobs
     SET status='completed', completed_at=NOW()
     WHERE id=$1`,
    [jobId]
  );
}

async function markJobFailed(jobId, error) {
  await db.query(
    `UPDATE mining_jobs
     SET status='failed', completed_at=NOW(), error=$2
     WHERE id=$1`,
    [jobId, error || 'Unknown error']
  );
}

async function cleanupStaleJobs() {
  const res = await db.query(
    `UPDATE mining_jobs
     SET status='failed', completed_at=NOW(),
         error='Worker crash or timeout'
     WHERE status='running'
       AND started_at < NOW() - INTERVAL '${STALE_JOB_THRESHOLD_MS} milliseconds'
     RETURNING id`
  );

  if (res.rows.length) {
    console.log(`🧹 Cleaned ${res.rows.length} stale jobs`);
  }
}

function setupShutdownHandlers() {
  const shutdown = async () => {
    isShuttingDown = true;
    if (currentJobProcess) {
      try { process.kill(currentJobProcess.pid); } catch {}
    }
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (require.main === module) {
  runWorker().catch(err => {
    console.error('💥 Fatal worker error', err);
    process.exit(1);
  });
}
