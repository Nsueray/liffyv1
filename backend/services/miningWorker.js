const { chromium } = require("playwright");
const db = require("../db");

// ENV
const JOB_ID = process.env.MINING_JOB_ID || null;

/**
 * Save mining results to DB
 */
async function saveResultsToDb(job, results, summary) {
  try {
    const jobId = job.id;
    if (!jobId) {
      console.log("⚠️ Cannot save results: job.id is missing");
      return;
    }

    if (!job.organizer_id) {
      throw new Error("Missing organizer_id for job");
    }

    console.log(`💾 Saving ${results.length} results to DB for job ${jobId}...`);

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      let totalEmails = 0;

      for (const r of results) {
        const emails = Array.isArray(r.emails)
          ? r.emails.filter((e) => typeof e === "string")
          : [];

        totalEmails += emails.length;

        await client.query(
          `
          INSERT INTO public.mining_results (
            job_id,
            organizer_id,
            source_url,
            company_name,
            contact_name,
            job_title,
            phone,
            country,
            website,
            emails,
            raw
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
          )
          `,
          [
            jobId,
            job.organizer_id,
            r.url || "",
            r.companyName || null,
            r.contactName || null,
            r.jobTitle || null,
            r.phone || null,
            r.country || null,
            r.website || null,
            emails,
            JSON.stringify(r), // PostgreSQL JSONB için
          ]
        );
      }

      const totalFound = results.length;
      const statsPayload = {
        ...(summary || {}),
        total_found: totalFound,
        total_emails_raw: totalEmails,
        saved_at: new Date().toISOString(),
      };

      await client.query(
        `UPDATE public.mining_jobs 
         SET total_found = COALESCE(total_found, 0) + $1, 
             total_emails_raw = COALESCE(total_emails_raw, 0) + $2, 
             stats = COALESCE(stats, '{}'::jsonb) || $3::jsonb, 
             status = 'completed', 
             completed_at = NOW() 
         WHERE id = $4`,
        [totalFound, totalEmails, JSON.stringify(statsPayload), jobId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    console.log("✅ Results saved to DB");
  } catch (err) {
    console.log("❌ Error saving results to DB:", err.message);
  }
}

// Global website blacklist for URL shorteners / trackers / default links
const WEBSITE_BLACKLIST_HOSTS = [
  "shorturl.at", "bit.ly", "tinyurl.com", "t.co", "goo.gl",
  "is.gd", "ow.ly", "buff.ly", "rebrand.ly", "short.link",
  "cutt.ly", "tiny.cc", "bitly.com", "shorte.st",
  "ufi.org" // Exhibition organization default/sponsor link
];

function isBlacklistedWebsite(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return WEBSITE_BLACKLIST_HOSTS.some(blocked =>
      host === blocked || host.endsWith("." + blocked)
    );
  } catch (e) {
    return false;
  }
}

/**
 * Generic email extractor from HTML
 */
function extractEmails(html) {
  const regex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const matches = html.match(regex) || [];
  
  const normalized = matches
    .map(e => e.trim().replace(/[,;:.]+$/, ""))
    .filter(Boolean);
  
  return Array.from(new Set(normalized));
}

/**
 * Guess website from email domain
 */
function guessWebsiteFromEmail(emails) {
  const genericProviders = [
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com",
    "aol.com", "icloud.com", "mail.com", "yandex.com",
    "protonmail.com", "qq.com", "163.com", "126.com",
    "live.com", "msn.com", "me.com", "mac.com"
  ];

  if (!emails || emails.length === 0) return null;

  for (const email of emails) {
    const parts = email.split("@");
    if (parts.length !== 2) continue;
    const domain = parts[1].toLowerCase();

    const isGeneric = genericProviders.some(
      provider => domain === provider.toLowerCase()
    );

    if (!isGeneric) {
      return `https://${domain}`;
    }
  }

  return null;
}

/**
 * Extract exhibitor detail links from HTML
 */
function extractExhibitorLinks(html, baseUrl, config = {}) {
  const links = [];
  const hrefRegex = /href="([^"]+)"/gi;
  let match;

  // Use pattern from config or default
  const pattern = config.detail_url_pattern || "/Exhibitor/ExbDetails/";

  while ((match = hrefRegex.exec(html)) !== null) {
    let url = match[1];

    // Skip if doesn't match pattern
    if (!url.includes(pattern)) continue;

    // Decode HTML entities
    url = url.replace(/&amp;/g, "&");

    // Convert to absolute URL
    try {
      if (url.startsWith("http")) {
        links.push(url);
      } else if (url.startsWith("/")) {
        const base = new URL(baseUrl);
        links.push(`${base.protocol}//${base.host}${url}`);
      }
    } catch (e) {
      // Skip invalid URLs
    }
  }

  return Array.from(new Set(links));
}

/**
 * Extract meta info from exhibitor detail page
 */
async function extractExhibitorMeta(page, exUrl, exHtml, exEmails) {
  const pageTitle = await page.title().catch(() => null);

  let companyName = null;
  let contactName = null;
  let jobTitle = null;
  let website = null;
  let phone = null;
  let country = null;

  // Company name extraction
  try {
    companyName = await page.$eval("h1", el => el.textContent.trim()).catch(() => null);
    if (!companyName) {
      companyName = await page.$eval(
        "h2.company-name, h2.exhibitor-name, .company-title, .exhibitor-title",
        el => el.textContent.trim()
      ).catch(() => null);
    }
  } catch (e) {
    // ignore
  }

  // Extract all meta via DOM evaluation
  try {
    const extra = await page.evaluate(() => {
      const result = {
        website: null,
        contactName: null,
        jobTitle: null,
        phone: null,
        country: null
      };

      // Website extraction
      const anchors = Array.from(document.querySelectorAll("a"));
      for (const a of anchors) {
        const href = (a.getAttribute("href") || "").trim();
        const text = (a.textContent || "").trim().toLowerCase();
        const target = a.getAttribute("target") || "";
        
        if (!href || !href.startsWith("http")) continue;
        
        // Skip exhibition/social domains
        if (
          href.includes("exhibitors.big5") ||
          href.includes("big5construct") ||
          href.includes("dmg") ||
          href.includes("facebook.com") ||
          href.includes("twitter.com") ||
          href.includes("linkedin.com") ||
          href.includes("instagram.com") ||
          href.includes("youtube.com") ||
          href.includes("shorturl.at") ||
          href.includes("bit.ly")
        ) continue;
        
        // Prioritize links that open in new tab or have "website" text
        if (
          target === "_blank" ||
          text.includes("website") ||
          text.includes("visit") ||
          text.includes("www")
        ) {
          result.website = href;
          break;
        }
      }
      
      // Phone extraction
      const phonePatterns = [
        /(?:tel:|phone:|mobile:|cell:)?\s*(\+?[\d\s\-().]+(?:\d{4,}))/gi,
        /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?[\s.-]?\d{1,4}[\s.-]?\d{1,4}/g,
        /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g
      ];
      
      const textContent = document.body.innerText || "";
      for (const pattern of phonePatterns) {
        const matches = textContent.match(pattern);
        if (matches && matches.length > 0) {
          const phone = matches[0].replace(/^(tel:|phone:|mobile:|cell:)/i, "").trim();
          if (phone.replace(/\D/g, "").length >= 7) {
            result.phone = phone;
            break;
          }
        }
      }
      
      // Country extraction
      const countrySelectors = [
        ".country", ".location", ".address .country",
        "[data-field='country']", ".exhibitor-country",
        ".company-country", ".address-country"
      ];
      
      for (const sel of countrySelectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.textContent) {
            result.country = el.textContent.trim();
            break;
          }
        } catch (e) {
          // Skip
        }
      }
      
      // Contact name extraction
      const contactSelectors = [
        ".contact-name", ".contact_person", ".contact-person",
        ".person-name", ".representative", ".rep-name",
        "[data-field='contact']", ".exhibitor-contact .name"
      ];
      
      for (const sel of contactSelectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.textContent) {
            const text = el.textContent.trim();
            if (text.length > 2 && text.length < 100 &&
                !text.toLowerCase().includes("contact") &&
                !text.toLowerCase().includes("representative")) {
              result.contactName = text;
              break;
            }
          }
        } catch (e) {
          // Skip
        }
      }
      
      // Job title extraction
      const jobSelectors = [
        ".job-title", ".designation", ".position", ".title",
        "[data-field='title']", ".contact-title", ".role"
      ];
      
      for (const sel of jobSelectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.textContent) {
            const text = el.textContent.trim();
            if (text.length > 2 && text.length < 100) {
              result.jobTitle = text;
              break;
            }
          }
        } catch (e) {
          // Skip
        }
      }
      
      return result;
    });

    website = extra.website || null;
    contactName = extra.contactName || null;
    jobTitle = extra.jobTitle || null;
    phone = extra.phone || null;
    country = extra.country || null;
  } catch (e) {
    // ignore
  }

  // Final fallback: guess website from email
  if (!website && exEmails && exEmails.length > 0) {
    const guessed = guessWebsiteFromEmail(exEmails);
    if (guessed) {
      website = guessed;
      console.log(`  💡 Website guessed from email: ${website}`);
    }
  }

  // Double-check: if website is blacklisted, try email fallback
  if (website && isBlacklistedWebsite(website)) {
    console.log(`  ⚠️ Ignoring blacklisted website: ${website}`);
    website = guessWebsiteFromEmail(exEmails) || null;
  }

  return {
    url: exUrl,
    pageTitle,
    companyName,
    contactName,
    jobTitle,
    phone,
    country,
    website,
    emails: exEmails || []
  };
}

/**
 * Wait for exhibitor links to appear in DOM
 */
async function waitForExhibitorLinks(page, config = {}) {
  // Generic selectors that work across different exhibition sites
  const genericSelectors = [
    'a[href*="/Exhibitor/"]',
    'a[href*="/exhibitor/"]',
    'a[href*="/profile/"]',
    'a[href*="/company/"]',
    'a[href*="/details/"]',
    'a[href*="/view/"]',
    'a[href*="/show/"]',
    'a[href*="ExbDetails"]',
    'a[href*="exhibitor-detail"]',
    'a[href*="company-profile"]'
  ];

  // Also check for pattern from config if provided
  if (config.detail_url_pattern) {
    genericSelectors.unshift(`a[href*="${config.detail_url_pattern}"]`);
  }

  // Try each selector with a shorter timeout
  for (const selector of genericSelectors) {
    try {
      await page.waitForSelector(selector, { 
        timeout: 5000,
        state: 'attached'
      });
      console.log(`  ✅ Found exhibitor links with selector: ${selector}`);
      return true;
    } catch (e) {
      // Try next selector
    }
  }

  // If no specific exhibitor links found, wait for any meaningful content
  try {
    await page.waitForFunction(
      () => {
        const links = document.querySelectorAll('a[href]');
        const meaningfulLinks = Array.from(links).filter(a => {
          const href = a.getAttribute('href') || '';
          return href.length > 10 && 
                 !href.startsWith('#') && 
                 !href.includes('javascript:') &&
                 (href.includes('/') || href.includes('http'));
        });
        return meaningfulLinks.length > 5;
      },
      { timeout: 10000 }
    );
    console.log(`  ⚠️ No specific exhibitor selectors matched, but found general links`);
    return true;
  } catch (e) {
    console.log(`  ⚠️ Warning: Could not detect exhibitor links after waiting`);
    return false;
  }
}

/**
 * Smart pagination handler with multiple strategies
 */
async function getAllExhibitorLinks(page, baseUrl, config = {}) {
  const allExhibitorLinks = [];
  const seenHashes = new Set();

  const maxPages = config.max_pages || 20;
  const delayMs = config.list_page_delay_ms || 2000;
  const detailPattern = config.detail_url_pattern || "/Exhibitor/ExbDetails/";

  console.log("📄 Starting pagination crawler...");
  console.log(`  Config: max_pages=${maxPages}, delay=${delayMs}ms, pattern="${detailPattern}"`);

  // Load first page
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  
  // Wait for JS-rendered content on initial page
  console.log("  ⏳ Waiting for exhibitor links to load...");
  await waitForExhibitorLinks(page, config);
  
  // Additional wait for dynamic content
  await page.waitForTimeout(1000);

  // Detect pagination info
  const paginationInfo = await page.evaluate(() => {
    const result = {
      totalExhibitors: null,
      hasNextButton: false,
      hasPageNumbers: false,
      lastPageNumber: 1
    };

    const bodyText = document.body.innerText || "";
    
    // Look for total count
    const showingMatch = bodyText.match(/showing\s+(\d+)\s+to\s+(\d+)\s+of\s+(\d+)/i);
    if (showingMatch) {
      result.totalExhibitors = parseInt(showingMatch[3]);
    }

    // Check for Next button
    const nextButtons = Array.from(document.querySelectorAll("a, button"))
      .filter(el => {
        const text = (el.textContent || "").toLowerCase().trim();
        return text === "next" || text === ">" || text === "»";
      });
    result.hasNextButton = nextButtons.length > 0;

    // Check for page numbers
    const pageLinks = Array.from(document.querySelectorAll("a, button"));
    for (const link of pageLinks) {
      const text = (link.textContent || "").trim();
      if (/^[1-9]\d*$/.test(text)) {
        const num = parseInt(text);
        if (num > 0 && num < 100) {
          result.lastPageNumber = Math.max(result.lastPageNumber, num);
          result.hasPageNumbers = true;
        }
      }
    }

    return result;
  });

  console.log(`📊 Pagination detection:`, paginationInfo);

  // Calculate total pages
  let totalPages = 1;
  if (paginationInfo.totalExhibitors) {
    totalPages = Math.ceil(paginationInfo.totalExhibitors / 24); // Assume 24 per page
  }
  totalPages = Math.max(
    totalPages,
    paginationInfo.lastPageNumber,
    config.force_page_count || 1
  );
  totalPages = Math.min(totalPages, maxPages);

  console.log(`📖 Will crawl ${totalPages} pages`);

  // Crawl all pages
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    if (pageNum > 1) {
      // Try URL parameter method
      const paramUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}page=${pageNum}`;
      
      try {
        console.log(`  🔄 Loading page ${pageNum}: ${paramUrl}`);
        await page.goto(paramUrl, { waitUntil: "networkidle", timeout: 15000 });
        
        // Wait for JS-rendered content on paginated page
        console.log(`  ⏳ Waiting for exhibitor links on page ${pageNum}...`);
        await waitForExhibitorLinks(page, config);
        await page.waitForTimeout(1000);
        
      } catch (e) {
        console.log(`  ⚠️ Failed to load page ${pageNum}: ${e.message}`);
        
        // Try clicking Next button as fallback
        try {
          const clicked = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll("a, button"));
            for (const link of links) {
              const text = (link.textContent || "").toLowerCase().trim();
              if (text === "next" || text === ">" || text === "»") {
                link.click();
                return true;
              }
            }
            return false;
          });
          
          if (clicked) {
            console.log(`  ⏳ Clicked Next button, waiting for content...`);
            await page.waitForTimeout(delayMs);
            await waitForExhibitorLinks(page, config);
          } else {
            console.log(`  ❌ Could not navigate to page ${pageNum}`);
            break;
          }
        } catch (e) {
          console.log(`  ❌ Navigation failed: ${e.message}`);
          break;
        }
      }
      
      await page.waitForTimeout(delayMs);
    } else {
      // First page already loaded and waited for
      await page.waitForTimeout(500);
    }

    // Extract links from current page
    const links = extractExhibitorLinks(await page.content(), baseUrl, config);
    
    if (links.length > 0) {
      const hash = links.slice(0, 5).sort().join("|");
      if (!seenHashes.has(hash)) {
        seenHashes.add(hash);
        allExhibitorLinks.push(...links);
        console.log(`  ✅ Page ${pageNum}: found ${links.length} exhibitors`);
      } else {
        console.log(`  ⚠️ Page ${pageNum} has duplicate content`);
      }
    } else {
      console.log(`  ⚠️ Page ${pageNum}: no exhibitors found`);
      
      // Try alternative extraction if pattern-based extraction failed
      const alternativeLinks = await page.evaluate(() => {
        const links = [];
        const anchors = document.querySelectorAll('a[href]');
        anchors.forEach(a => {
          const href = a.getAttribute('href') || '';
          if (href.match(/\/(exhibitor|Exhibitor|profile|company|details|view|show)[\/\-]/i) ||
              href.match(/ExbDetails|exhibitor-detail|company-profile/i)) {
            links.push(href);
          }
        });
        return links;
      });
      
      if (alternativeLinks.length > 0) {
        console.log(`  🔄 Found ${alternativeLinks.length} exhibitors using alternative extraction`);
        for (const link of alternativeLinks) {
          try {
            if (link.startsWith("http")) {
              allExhibitorLinks.push(link);
            } else if (link.startsWith("/")) {
              const base = new URL(baseUrl);
              allExhibitorLinks.push(`${base.protocol}//${base.host}${link}`);
            }
          } catch (e) {
            // Skip invalid URLs
          }
        }
      }
    }
  }

  // Remove duplicates
  const uniqueLinks = Array.from(new Set(allExhibitorLinks));
  console.log(`\n✅ Total unique exhibitor links collected: ${uniqueLinks.length}`);

  return uniqueLinks;
}

/**
 * Main mining routine with Playwright
 */
async function runPlaywrightStrategy(job) {
  const url = job.input;
  const config = job.config || {};

  console.log(`🌐 Launching browser for: ${url}`);
  
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const allResults = [];

  try {
    // Mark job as running
    const client = await db.connect();
    try {
      await client.query(
        'UPDATE mining_jobs SET status = $1, started_at = NOW() WHERE id = $2',
        ['running', job.id]
      );
    } finally {
      client.release();
    }

    // Get all exhibitor links with pagination
    const exhibitorLinks = await getAllExhibitorLinks(page, url, config);

    if (exhibitorLinks.length === 0) {
      console.log("⚠️ No exhibitor links found");
      return;
    }

    console.log("\n🏢 Sample links:", exhibitorLinks.slice(0, 5));
    console.log(`\n🔎 Visiting ${exhibitorLinks.length} detail pages...`);

    const startTime = Date.now();

    // Visit each detail page
    for (let i = 0; i < exhibitorLinks.length; i++) {
      const exUrl = exhibitorLinks[i];
      const progress = ((i + 1) / exhibitorLinks.length * 100).toFixed(1);
      
      // Calculate ETA
      const elapsed = Date.now() - startTime;
      const avgTime = elapsed / (i + 1);
      const remaining = (exhibitorLinks.length - i - 1) * avgTime;
      const eta = new Date(Date.now() + remaining).toLocaleTimeString();
      
      console.log(`\n➡️ [${i + 1}/${exhibitorLinks.length}] (${progress}%) ETA: ${eta}`);
      console.log(`   ${exUrl.substring(exUrl.lastIndexOf('/') + 1)}`);
      
      try {
        await page.goto(exUrl, { waitUntil: "networkidle", timeout: 30000 });
        
        const html = await page.content();
        const emails = extractEmails(html);
        const meta = await extractExhibitorMeta(page, exUrl, html, emails);
        
        if (emails.length > 0 || meta.companyName || meta.website) {
          console.log(`  ✅ ${meta.companyName || "Unknown"}`);
          if (emails.length > 0) console.log(`  📧 ${emails.join(", ")}`);
          if (meta.website) console.log(`  🌐 ${meta.website}`);
          if (meta.phone) console.log(`  📞 ${meta.phone}`);
          if (meta.country) console.log(`  🌍 ${meta.country}`);
        }
        
        allResults.push(meta);
        
        // Rate limiting
        const delay = config.detail_delay_ms || 800;
        if (i < exhibitorLinks.length - 1) {
          await page.waitForTimeout(delay);
        }
      } catch (err) {
        console.log(`  ❌ Error: ${err.message}`);
        allResults.push({
          url: exUrl,
          emails: [],
          error: err.message
        });
      }
    }

    // Summary statistics
    const totalTime = ((Date.now() - startTime) / 60000).toFixed(1);
    const emailsFound = allResults.filter(r => r.emails && r.emails.length > 0);
    const websitesFound = allResults.filter(r => r.website);
    const contactsFound = allResults.filter(r => r.contactName);
    const totalEmails = allResults.reduce((sum, r) => sum + (r.emails?.length || 0), 0);

    console.log("\n" + "=".repeat(60));
    console.log("📊 MINING COMPLETE");
    console.log("=".repeat(60));
    console.log(`  ⏱️ Time: ${totalTime} minutes`);
    console.log(`  📍 Exhibitors: ${exhibitorLinks.length}`);
    console.log(`  📧 Emails: ${totalEmails} (from ${emailsFound.length} exhibitors)`);
    console.log(`  🌐 Websites: ${websitesFound.length}`);
    console.log(`  👤 Contacts: ${contactsFound.length}`);
    console.log(`  📈 Email coverage: ${(emailsFound.length / exhibitorLinks.length * 100).toFixed(1)}%`);

    // Prepare summary for database
    const summary = {
      total_exhibitors: exhibitorLinks.length,
      total_results: allResults.length,
      total_emails: totalEmails,
      exhibitors_with_emails: emailsFound.length,
      websites_found: websitesFound.length,
      contacts_found: contactsFound.length,
      time_minutes: parseFloat(totalTime)
    };

    // Save results to database
    await saveResultsToDb(job, allResults, summary);

    // Show top results
    const withEmails = allResults.filter(r => r.emails?.length > 0).slice(0, 10);
    if (withEmails.length > 0) {
      console.log("\n📋 Sample results:");
      withEmails.forEach((r, i) => {
        console.log(`\n  ${i + 1}. ${r.companyName || "Unknown"}`);
        console.log(`     📧 ${r.emails.join(", ")}`);
        if (r.website) console.log(`     🌐 ${r.website}`);
      });
    }

  } catch (err) {
    console.log("❌ Mining failed:", err.message);
    
    // Mark job as failed
    const client = await db.connect();
    try {
      await client.query(
        'UPDATE mining_jobs SET status = $1, error = $2 WHERE id = $3',
        ['failed', err.message, job.id]
      );
    } finally {
      client.release();
    }
    
    throw err;
  } finally {
    await browser.close();
  }
}

/**
 * Main entry point
 */
async function runMiningTest() {
  console.log("⛏️ Mining Worker started");
  console.log(`📅 ${new Date().toLocaleString()}`);

  if (!JOB_ID) {
    console.log("❗ MINING_JOB_ID is not set, job will not be fetched.");
    return;
  }

  let job;
  const client = await db.connect();
  
  try {
    console.log(`📥 Fetching mining job: ${JOB_ID}`);
    const res = await client.query(
      'SELECT * FROM mining_jobs WHERE id = $1',
      [JOB_ID]
    );
    
    if (res.rows.length === 0) {
      throw new Error("Mining job not found");
    }
    
    job = res.rows[0];
    console.log("✅ Job data loaded:", {
      id: job.id,
      name: job.name,
      input: job.input,
      strategy: job.strategy
    });
  } catch (err) {
    console.log("❌ Error fetching job:", err.message);
    return;
  } finally {
    client.release();
  }

  const strategy = job.strategy || "auto";
  const config = job.config || {};

  console.log(`⚙️ Job strategy: ${strategy}`);
  console.log(`⚙️ Job config:`, config);

  if (strategy === "http") {
    console.log("⚠️ HTTP-only strategy not implemented yet. Use 'auto' or 'playwright'.");
    return;
  }

  try {
    // Run mining with Playwright strategy
    await runPlaywrightStrategy(job);
  } catch (err) {
    console.log("❌ Mining failed:", err.message);
  }

  console.log(`\n📅 Completed: ${new Date().toLocaleString()}`);
  console.log("⛏️ Mining Worker finished");
}

// Export for testing
module.exports = { runMiningTest };

// Run if called directly
if (require.main === module) {
  runMiningTest().catch(console.error);
}
