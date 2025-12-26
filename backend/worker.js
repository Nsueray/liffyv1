/**
 * LIFFY BIG5-COMPATIBLE WORKER
 * Direct link extraction (no ID parsing needed)
 */

const db = require("./db");
const { chromium } = require("playwright");

const POLL_INTERVAL_MS = 5000;
const MAX_LIST_PAGES = 10;
const MAX_DETAIL_PAGES = 300;

let shuttingDown = false;

async function startWorker() {
  console.log("🚀 Liffy Worker started (Big5 Compatible)");

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  while (!shuttingDown) {
    try {
      await processNextJob();
    } catch (err) {
      console.error("Worker error:", err.message);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function processNextJob() {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const res = await client.query(`
      SELECT * FROM mining_jobs
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
    console.log(`\n⛏️ Processing job ${job.id}`);
    console.log(`📌 URL: ${job.input}`);

    await client.query(
      `UPDATE mining_jobs SET status='running', started_at=NOW() WHERE id=$1`,
      [job.id]
    );
    await client.query("COMMIT");

    const stats = await mineBig5Site(job);
    await markCompleted(job.id, stats);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Job failed:", err.message);
  } finally {
    client.release();
  }
}

async function mineBig5Site(job) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const page = await browser.newPage();
  const allDetailLinks = new Set();
  let emailCount = 0;

  try {
    console.log("📄 Collecting exhibitor links...");

    // STEP 1: Collect all exhibitor links from paginated list
    for (let pageNum = 1; pageNum <= MAX_LIST_PAGES; pageNum++) {
      // Build correct URL for pagination
      let listUrl = job.input;
      
      if (pageNum > 1) {
        // Check if base URL already has parameters
        const separator = listUrl.includes('?') ? '&' : '?';
        listUrl = `${job.input}${separator}page=${pageNum}`;
      }
      
      console.log(`  Page ${pageNum}: ${listUrl}`);
      
      // Navigate and wait for content
      await page.goto(listUrl, { 
        waitUntil: "networkidle",  // ← CRITICAL: Wait for JS to load
        timeout: 60000 
      });
      
      // Aggressive scroll to trigger lazy loading
      console.log("    Scrolling to load content...");
      for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, 2000);
        await page.waitForTimeout(800);
      }
      
      // Wait for exhibitor links to appear
      await page.waitForTimeout(2000);
      
      // Extract exhibitor detail links directly (no ID parsing)
      const links = await page.$$eval(
        'a[href*="/Exhibitor/"], a[href*="/exhibitor/"], a[href*="ExbDetails"]',
        els => els.map(el => el.href).filter(href => 
          href.includes('/Exhibitor/') || 
          href.includes('/exhibitor/') || 
          href.includes('ExbDetails')
        )
      );
      
      console.log(`    Found ${links.length} exhibitor links`);
      
      if (links.length === 0) {
        // Try alternative: check if we're on an empty page
        const hasContent = await page.$eval('body', el => 
          el.innerText.includes('Exhibitor') || 
          el.innerText.includes('Company')
        ).catch(() => false);
        
        if (!hasContent) {
          console.log("    No content on this page, stopping");
          break;
        }
      }
      
      // Add to set (removes duplicates)
      links.forEach(link => allDetailLinks.add(link));
      
      // Try to find next page button
      const hasNext = await page.$('a:has-text("Next"), a:has-text(">")');
      if (!hasNext && pageNum > 1 && links.length === 0) {
        console.log("    No more pages");
        break;
      }
    }
    
    console.log(`\n🔗 Total unique exhibitor links: ${allDetailLinks.size}`);
    
    // STEP 2: Visit each detail page
    let visited = 0;
    for (const detailUrl of allDetailLinks) {
      if (visited >= MAX_DETAIL_PAGES) break;
      visited++;
      
      try {
        console.log(`[${visited}/${allDetailLinks.size}] ${detailUrl.split('/').pop()}`);
        
        await page.goto(detailUrl, { 
          waitUntil: "domcontentloaded",
          timeout: 30000 
        });
        
        await page.waitForTimeout(1000);
        
        const html = await page.content();
        const emails = extractEmails(html);
        
        if (emails.length > 0) {
          await saveResult(job, detailUrl, emails);
          emailCount += emails.length;
          console.log(`  ✅ Found: ${emails.join(', ')}`);
        }
        
      } catch (err) {
        console.log(`  ⚠️ Failed: ${err.message}`);
      }
    }
    
  } finally {
    await browser.close();
  }

  return { 
    results: allDetailLinks.size, 
    emails: emailCount 
  };
}

function extractEmails(text) {
  const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
  return [...new Set(
    (text.match(regex) || []).filter(e =>
      !e.includes(".png") &&
      !e.includes(".jpg") &&
      !e.includes("@2x") &&
      e.length < 100
    )
  )];
}

async function saveResult(job, source, emails) {
  await db.query(
    `INSERT INTO mining_results
     (job_id, organizer_id, source_url, emails)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [job.id, job.organizer_id, source, emails]
  );
}

async function markCompleted(jobId, stats) {
  await db.query(
    `UPDATE mining_jobs
     SET status='completed', completed_at=NOW(),
         total_found=$2, total_emails_raw=$3
     WHERE id=$1`,
    [jobId, stats.results, stats.emails]
  );

  console.log(`\n✅ Job completed`);
  console.log(`   Links visited: ${stats.results}`);
  console.log(`   Emails found: ${stats.emails}`);
}

function shutdown() {
  console.log("🛑 Worker shutting down");
  shuttingDown = true;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

startWorker().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
