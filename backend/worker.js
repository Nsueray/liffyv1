/**
 * Docker-based Playwright Mining Worker
 * AutoMiner FINAL
 *
 * Behaviour:
 * - User selects NOTHING
 * - System tries:
 *   1) Direct page scan
 *   2) Internal high-signal pages
 *   3) List → Detail crawl (expo-style)
 *   4) Controlled deep crawl
 * - Stops as soon as emails are found
 */

const db = require('./db');
const { chromium } = require('playwright');
const { URL } = require('url');

const POLL_INTERVAL_MS = 5000;
const MAX_LIST_PAGES = 3;
const MAX_DETAIL_PAGES = 50;

let shuttingDown = false;

/* =========================
   WORKER LOOP
========================= */

async function startWorker() {
  console.log('🚀 Mining Worker started (AutoMiner FINAL)');

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

    await markCompleted(job.id, found);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Job failed:', err.message);
  } finally {
    client.release();
  }
}

/* =========================
   AUTO MINER
========================= */

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

  /* ---------- STRATEGY 1: Direct page ---------- */
  console.log('AUTO: direct_page_scan');
  await page.goto(job.input, { waitUntil: 'domcontentloaded', timeout: 60000 });
  totalFound += await extractAndSave(page, job);
  if (totalFound > 0) {
    await browser.close();
    return totalFound;
  }

  /* ---------- STRATEGY 2: High-signal internal pages ---------- */
  console.log('AUTO: internal_high_signal_pages');
  const internalPages = await collectHighSignalPages(page, job.input);
  for (const url of internalPages) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      totalFound += await extractAndSave(page, job);
      if (totalFound > 0) break;
    } catch {}
  }
  if (totalFound > 0) {
    await browser.close();
    return totalFound;
  }

  /* ---------- STRATEGY 3: List → Detail crawl (EXPO CORE) ---------- */
  console.log('AUTO: list_to_detail_crawl');
  const listPages = await detectListPages(internalPages);

  let detailVisited = 0;

  for (const listUrl of listPages.slice(0, MAX_LIST_PAGES)) {
    try {
      await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

      // Scroll to load JS content
      await autoScroll(page);

      const detailLinks = await collectDetailLinks(page, job.input);

      for (const detailUrl of detailLinks) {
        if (detailVisited >= MAX_DETAIL_PAGES) break;
        detailVisited++;

        try {
          await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
          totalFound += await extractAndSave(page, job);
          if (totalFound > 0) break;
        } catch {}
      }

      if (totalFound > 0) break;

    } catch {}
  }

  await browser.close();
  return totalFound;
}

/* =========================
   HELPERS
========================= */

async function collectHighSignalPages(page, baseUrl) {
  const base = new URL(baseUrl);
  const domain = base.hostname;

  const patterns = [
    'exhibitor', 'exhibitors',
    'participant', 'participants',
    'company', 'companies',
    'profile', 'brand', 'catalog', 'list'
  ];

  const hrefs = await page.$$eval('a[href]', els =>
    els.map(a => a.getAttribute('href')).filter(Boolean)
  );

  const urls = new Set();

  for (const href of hrefs) {
    try {
      const url = new URL(href, base);
      if (url.hostname !== domain) continue;
      if (patterns.some(p => url.pathname.toLowerCase().includes(p))) {
        urls.add(url.href);
      }
    } catch {}
  }

  return Array.from(urls);
}

function detectListPages(pages) {
  return pages.filter(u =>
    /exhibitors|participants|companies|catalog|list/i.test(u)
  );
}

async function collectDetailLinks(page, baseUrl) {
  const base = new URL(baseUrl);
  const domain = base.hostname;

  const hrefs = await page.$$eval('a[href]', els =>
    els.map(a => a.getAttribute('href')).filter(Boolean)
  );

  const links = new Set();

  for (const href of hrefs) {
    try {
      const url = new URL(href, base);
      if (url.hostname === domain && url.pathname.length > 10) {
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

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let total = 0;
      const distance = 500;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        total += distance;
        if (total >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 400);
    });
  });
  await page.waitForTimeout(2000);
}

async function markCompleted(jobId, found) {
  await db.query(
    `UPDATE mining_jobs
     SET status='completed',
         completed_at=NOW(),
         total_found=$2
     WHERE id=$1`,
    [jobId, found]
  );
  console.log(`✅ Job ${jobId} completed (found: ${found})`);
}

function shutdown() {
  console.log('🛑 Worker shutting down');
  shuttingDown = true;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

startWorker().catch(err => {
  console.error('Fatal worker error:', err);
  process.exit(1);
});
