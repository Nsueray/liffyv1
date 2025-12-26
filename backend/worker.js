/**
 * LIFFY ULTRA-HYBRID MINING WORKER (5-LAYER FINAL)
 *
 * Layers:
 * L1 - XHR / JSON interception
 * L2 - <script type="application/json"> parsing
 * L3 - DOM link discovery + pagination
 * L4 - Deep detail crawl (proven 170-result logic)
 * L5 - Aggressive text scan (last fallback)
 *
 * Deterministic, limited, production-safe
 */

const db = require("./db");
const { chromium } = require("playwright");
const { URL } = require("url");

const POLL_INTERVAL_MS = 5000;
const MAX_LIST_PAGES = 10;
const MAX_DETAIL_PAGES = 200;
const SCROLL_ROUNDS = 6;
const SCROLL_DELAY_MS = 900;
const PAGE_DELAY_MS = 1500;
const MAX_RESULTS = 500;

let shuttingDown = false;

/* ======================
   WORKER LOOP
====================== */

async function startWorker() {
  console.log("🚀 Liffy Mining Worker started (ULTRA-HYBRID 5-LAYER)");

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  while (!shuttingDown) {
    try {
      await processNextJob();
    } catch (err) {
      console.error("Worker loop error:", err.message);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function processNextJob() {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const res = await client.query(`
      SELECT *
      FROM mining_jobs
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);

    if (res.rows.length === 0) {
      await client.query("COMMIT");
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

    await client.query("COMMIT");

    const stats = await runUltraHybridMiner(job);
    await markCompleted(job.id, stats);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Job failed:", err.message);
  } finally {
    client.release();
  }
}

/* ======================
   ULTRA-HYBRID MINER
====================== */

async function runUltraHybridMiner(job) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  const collected = new Map(); // key -> { emails, source }
  const detailLinks = new Set();

  /* ---------- L1: XHR / JSON ---------- */
  page.on("response", async (response) => {
    try {
      const ct = response.headers()["content-type"] || "";
      if (!ct.includes("application/json")) return;

      const data = await response.json().catch(() => null);
      if (data) extractFromJSON(data, collected);
    } catch {}
  });

  try {
    console.log(`🌐 Opening ${job.input}`);
    await page.goto(job.input, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);

    /* ---------- L2: Script-tag JSON ---------- */
    const scriptJsons = await page.$$eval(
      'script[type="application/json"]',
      scripts => scripts.map(s => {
        try { return JSON.parse(s.textContent); } catch { return null; }
      }).filter(Boolean)
    );
    scriptJsons.forEach(j => extractFromJSON(j, collected));

    /* ---------- L3: Link discovery + pagination ---------- */
    for (let p = 1; p <= MAX_LIST_PAGES; p++) {
      await intelligentScroll(page);
      const links = await extractDetailLinksFromPage(page, job.input);
      links.forEach(l => detailLinks.add(l));

      const hasNext = await clickNextIfExists(page);
      if (!hasNext) break;
      await page.waitForTimeout(PAGE_DELAY_MS);
    }

    console.log(`🔗 Collected ${detailLinks.size} detail links`);

    /* ---------- L4: Deep detail crawl ---------- */
    let visited = 0;
    for (const link of detailLinks) {
      if (visited >= MAX_DETAIL_PAGES) break;
      if (collected.has(link)) continue;

      visited++;
      try {
        await page.goto(link, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(PAGE_DELAY_MS);

        const html = await page.content();
        const emails = extractEmails(html);
        if (emails.length > 0) {
          collected.set(link, { emails, source: link });
        }
      } catch {}
    }

    /* ---------- L5: Aggressive text scan ---------- */
    if (collected.size === 0) {
      const bodyText = await page.evaluate(() => document.body.innerText || "");
      const rawEmails = extractEmails(bodyText);
      rawEmails.forEach(e => {
        collected.set(e, { emails: [e], source: job.input });
      });
    }

  } finally {
    await browser.close();
  }

  /* ---------- SAVE ---------- */
  let saved = 0;
  let emailCount = 0;

  for (const item of collected.values()) {
    if (saved >= MAX_RESULTS) break;

    await db.query(
      `INSERT INTO mining_results
       (job_id, organizer_id, source_url, emails)
       VALUES ($1, $2, $3, $4)`,
      [
        job.id,
        job.organizer_id,
        item.source || job.input,
        item.emails || []
      ]
    );

    saved++;
    emailCount += item.emails.length;
  }

  return { results: saved, emails: emailCount };
}

/* ======================
   HELPERS
====================== */

function extractFromJSON(data, collected) {
  if (Array.isArray(data)) {
    data.forEach(d => extractFromJSON(d, collected));
    return;
  }
  if (typeof data !== "object" || !data) return;

  const emails = [];
  for (const v of Object.values(data)) {
    if (typeof v === "string" && v.includes("@")) {
      const found = v.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
      if (found) {
        found.forEach(e => {
          const l = e.toLowerCase();
          if (!l.endsWith(".png") && !l.endsWith(".jpg") && !l.includes("@2x")) {
            emails.push(e);
          }
        });
      }
    }
  }

  if (emails.length > 0) {
    const key = data.id || data.companyId || JSON.stringify(data).slice(0, 80);
    if (!collected.has(key)) {
      collected.set(key, { emails: Array.from(new Set(emails)), source: data.url || null });
    }
  }

  Object.values(data).forEach(v => extractFromJSON(v, collected));
}

function extractEmails(text) {
  const regex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  return Array.from(new Set(text.match(regex) || []));
}

async function extractDetailLinksFromPage(page, baseUrl) {
  const base = new URL(baseUrl);
  const domain = base.hostname;

  const hrefs = await page.$$eval("a[href]", els =>
    els.map(a => a.getAttribute("href")).filter(Boolean)
  );

  const patterns = ["ExbDetails", "exhibitor", "company", "profile", "participant"];
  const links = new Set();

  for (const href of hrefs) {
    try {
      const url = new URL(href, base);
      if (url.hostname === domain && patterns.some(p => url.pathname.includes(p))) {
        links.add(url.href);
      }
    } catch {}
  }

  return Array.from(links);
}

async function intelligentScroll(page) {
  for (let i = 0; i < SCROLL_ROUNDS; i++) {
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(SCROLL_DELAY_MS);
  }
}

async function clickNextIfExists(page) {
  try {
    const btn = await page.$(
      'a:has-text("Next"), button:has-text("Next"), a:has-text(">"), a.next'
    );
    if (!btn) return false;
    await btn.click();
    return true;
  } catch {
    return false;
  }
}

async function markCompleted(jobId, stats) {
  await db.query(
    `UPDATE mining_jobs
     SET status='completed',
         completed_at=NOW(),
         total_found=$2,
         total_emails_raw=$3
     WHERE id=$1`,
    [jobId, stats.results, stats.emails]
  );
  console.log(
    `✅ Job ${jobId} completed (results: ${stats.results}, emails: ${stats.emails})`
  );
}

function shutdown() {
  console.log("🛑 Worker shutting down");
  shuttingDown = true;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

startWorker().catch(err => {
  console.error("Fatal worker error:", err);
  process.exit(1);
});
