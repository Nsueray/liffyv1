/**
 * Docker-based Playwright Mining Worker
 * Render Background Worker compatible
 */

const db = require('./db');
const { chromium } = require('playwright');

const POLL_INTERVAL_MS = 5000;
let shuttingDown = false;

async function startWorker() {
  console.log('🚀 Mining Worker started');

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  while (!shuttingDown) {
    try {
      await processNextJob();
    } catch (err) {
      console.error('Worker loop error:', err.message);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function processNextJob() {
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const res = await client.query(`
      SELECT *
      FROM mining_jobs
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);

    if (res.rows.length === 0) {
      await client.query('COMMIT');
      return;
    }

    const job = res.rows[0];
    console.log(`⛏️ Processing job ${job.id}`);

    await client.query(
      `UPDATE mining_jobs
       SET status='running', started_at=NOW(), error=NULL
       WHERE id=$1`,
      [job.id]
    );

    await client.query('COMMIT');
    await runPlaywrightJob(job);
    await markCompleted(job.id);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Job failed:', err.message);
  } finally {
    if (client) client.release();
  }
}

async function runPlaywrightJob(job) {
  console.log(`🌐 Launching browser for ${job.input}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  const page = await browser.newPage();
  await page.goto(job.input, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const html = await page.content();
  const emails = extractEmails(html);

  await saveResults(job, emails);
  await browser.close();
}

function extractEmails(html) {
  const regex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  return Array.from(new Set(html.match(regex) || []));
}

async function saveResults(job, emails) {
  for (const email of emails) {
    await db.query(
      `INSERT INTO mining_results
       (job_id, organizer_id, source_url, emails)
       VALUES ($1, $2, $3, ARRAY[$4])`,
      [job.id, job.organizer_id, job.input, email]
    );
  }
}

async function markCompleted(jobId) {
  await db.query(
    `UPDATE mining_jobs
     SET status='completed', completed_at=NOW()
     WHERE id=$1`,
    [jobId]
  );
  console.log(`✅ Job ${jobId} completed`);
}

function shutdown() {
  console.log('🛑 Worker shutting down');
  shuttingDown = true;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

startWorker().catch(err => {
  console.error('Fatal worker error:', err);
  process.exit(1);
});
