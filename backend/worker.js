/**
 * DIAGNOSTIC VERSION - Big5 Debug
 * Bu kod sorunu tespit edecek
 */

const db = require("./db");
const { chromium } = require("playwright");

const POLL_INTERVAL_MS = 5000;
let shuttingDown = false;

async function startWorker() {
  console.log("🚀 Liffy Diagnostic Worker");

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
    console.log(`\n⛏️ Testing job ${job.id}`);
    
    await client.query(
      `UPDATE mining_jobs SET status='running', started_at=NOW() WHERE id=$1`,
      [job.id]
    );
    await client.query("COMMIT");

    await debugSite(job);
    
    // Mark as completed with 0 results for now
    await client.query(
      `UPDATE mining_jobs SET status='completed', completed_at=NOW(), total_found=0 WHERE id=$1`,
      [job.id]
    );

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed:", err.message);
  } finally {
    client.release();
  }
}

async function debugSite(job) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox", 
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
  });
  
  const page = await context.newPage();

  try {
    console.log(`📌 URL: ${job.input}`);
    
    // Try with different wait strategies
    console.log("\n1️⃣ Loading page with networkidle...");
    await page.goto(job.input, { 
      waitUntil: "networkidle",
      timeout: 60000 
    });
    
    // Check what's loaded
    console.log("\n2️⃣ Page diagnostics:");
    
    const title = await page.title();
    console.log(`   Title: ${title}`);
    
    const hasBody = await page.$eval('body', el => el.innerText.length).catch(() => 0);
    console.log(`   Body text length: ${hasBody}`);
    
    // Check for iframes
    const iframes = await page.$$eval('iframe', els => els.length);
    console.log(`   iframes found: ${iframes}`);
    
    // Check for common elements
    const diagnostics = await page.evaluate(() => {
      return {
        hasExhibitorText: document.body.innerText.includes('Exhibitor'),
        hasCompanyText: document.body.innerText.includes('Company'),
        totalLinks: document.querySelectorAll('a').length,
        totalDivs: document.querySelectorAll('div').length,
        hasLoadingElement: !!document.querySelector('.loading, .spinner, .loader'),
        hasErrorElement: !!document.querySelector('.error, .not-found'),
        documentReadyState: document.readyState
      };
    });
    
    console.log("\n3️⃣ Content analysis:");
    console.log(`   Has 'Exhibitor' text: ${diagnostics.hasExhibitorText}`);
    console.log(`   Has 'Company' text: ${diagnostics.hasCompanyText}`);
    console.log(`   Total links: ${diagnostics.totalLinks}`);
    console.log(`   Total divs: ${diagnostics.totalDivs}`);
    console.log(`   Has loading element: ${diagnostics.hasLoadingElement}`);
    console.log(`   Has error element: ${diagnostics.hasErrorElement}`);
    console.log(`   Document ready state: ${diagnostics.documentReadyState}`);
    
    // Try waiting for specific elements
    console.log("\n4️⃣ Waiting for exhibitor elements...");
    
    try {
      await page.waitForSelector('a[href*="Exhibitor"]', { timeout: 10000 });
      console.log("   ✅ Found exhibitor links!");
    } catch {
      console.log("   ❌ No exhibitor links found after 10s");
    }
    
    // Try scrolling aggressively
    console.log("\n5️⃣ Aggressive scrolling test...");
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);
    }
    
    // Check all href patterns
    const allHrefs = await page.$$eval('a[href]', els => 
      els.map(el => el.href).filter(h => h && h.length > 0)
    );
    
    console.log(`\n6️⃣ Found ${allHrefs.length} total links`);
    
    // Show sample links
    const sampleLinks = allHrefs.slice(0, 10);
    console.log("   Sample links:");
    sampleLinks.forEach(link => {
      console.log(`   - ${link}`);
    });
    
    // Check specifically for exhibitor patterns
    const exhibitorLinks = allHrefs.filter(href => 
      href.includes('/Exhibitor/') || 
      href.includes('/exhibitor/') ||
      href.includes('ExbDetails') ||
      href.includes('/company/') ||
      href.includes('/profile/')
    );
    
    console.log(`\n7️⃣ Exhibitor links found: ${exhibitorLinks.length}`);
    if (exhibitorLinks.length > 0) {
      console.log("   First 5 exhibitor links:");
      exhibitorLinks.slice(0, 5).forEach(link => {
        console.log(`   - ${link}`);
      });
    }
    
    // Check page source
    const pageSource = await page.content();
    console.log(`\n8️⃣ Page source size: ${pageSource.length} bytes`);
    
    // Look for API calls
    console.log("\n9️⃣ Checking for API/AJAX patterns in source...");
    const hasAjax = pageSource.includes('ajax') || pageSource.includes('fetch') || pageSource.includes('axios');
    const hasAPI = pageSource.includes('/api/') || pageSource.includes('endpoint');
    console.log(`   Has AJAX references: ${hasAjax}`);
    console.log(`   Has API references: ${hasAPI}`);
    
    // Check console errors
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    
    // Reload to catch console errors
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(5000);
    
    if (consoleErrors.length > 0) {
      console.log("\n🔟 Console errors detected:");
      consoleErrors.forEach(err => console.log(`   - ${err}`));
    }
    
  } finally {
    await browser.close();
  }
  
  console.log("\n✅ Diagnostic complete");
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
