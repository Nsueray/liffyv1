/**
 * Docker-based Playwright Mining Worker
 * AutoMiner V1
 * - No user-selected modes
 * - Automatically tries multiple strategies
 * - Stops when results are found
 */

const db = require('./db');
const { chromium } = require('playwright');
const { URL } = require('url');

const POLL_INTERVAL_MS = 5000;
const MAX_INTERNAL_PAGES = 10;

let shuttingDown = false;

async function startWorker() {
  console.log('🚀 Mining Worker started (AutoMiner V1)');

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

    const found = await runAutoMiner(job);

    if (found > 0) {
      await markCompleted(job.id);
    } else {
      await markCompleted(job.id);
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Job failed:', err.message);
  } finally {
    if (client) client.release();
  }
}

async function runAutoMiner(job) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  let totalFound = 0;

  // STRATEGY 1 — Direct page scan
  console.log('AUTO: direct_page_scan');
  await page.goto(job.input, { waitUntil: 'domcontentloaded', timeout: 60000 });
  totalFound += await extractAndSave(page, job);

  if (totalFound > 0) {
    await browser.close();
    return totalFound;
  }

  // STRATEGY 2 — Internal link discovery
  console.log('AUTO: internal_link_discovery');

  const internalLinks = await collectInternalLinks(page, job.input);

  let visited = 0;
  for (const link of internalLinks) {
    if (visited >= MAX_INTERNAL_PAGES) break;
    visited++;

    try {
      await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
      totalFound += await extractAndSave(page, job);

      if (totalFound > 0) break;
    } catch (e) {
      continue;
    }
  }

  await browser.close();
  return totalFound;
}

async function collectInternalLinks(page, baseUrl) {
  const base = new URL(baseUrl);
  const domain = base.hostname;

  const hrefs = await page.$$eval('a[href]', els =>
    els.map(a => a.getAttribute('href')).filter(Boolean)
  );

  const highSignal = [
    'exhibitor',
    'exhibitors',
    'participant',
    'participants',
    'company',
    'profile',
    'brand',
    'list'
  ];

  const links = new Set();

  for (const href of hrefs) {
    try {
      const url = new URL(href, base);
      if (url.hostname !== domain) continue;

      const lower = url.pathname.toLowerCase();
      if (highSignal.some(p => lower.includes(p))) {
        links.add(url.href);
      }
    } catch {}
  }

  return Array.from(links);
}

async function extractAndSave(page, job) {
  const html = await page.content();
  const emails = extractEmails(html);

  if (emails.length === 0) return 0;

  for (const email of emails) {
    await db.query(
      `INSERT INTO mining_results
       (job_id, organizer_id, source_url, emails)
       VALUES ($1, $2, $3, ARRAY[$4])`,
      [job.id, job.organizer_id, page.url(), email]
    );
  }

  return emails.length;
}

function extractEmails(html) {
  const regex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  return Array.from(new Set(html.match(regex) || []));
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
