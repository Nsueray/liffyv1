const axios = require("axios");
const { chromium } = require("playwright");

// ENV
const API_BASE = process.env.MINING_API_BASE || "https://api.liffy.app/api";
const API_TOKEN = process.env.MINING_API_TOKEN;
const JOB_ID = process.env.MINING_JOB_ID || null;

// Axios client
const api = axios.create({
  baseURL: API_BASE,
  headers: API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {},
});

/**
 * Send mining results to API
 */
async function sendResultsToApi(job, results, summary) {
  try {
    const jobId = job.id || job.job_id;
    if (!jobId) {
      console.log("⚠️ Cannot send results: job.id is missing");
      return;
    }
    
    console.log(`📤 Sending ${results.length} results to API for job ${jobId}...`);
    
    const res = await api.post(`/mining/jobs/${jobId}/results`, {
      results,
      summary,
    });
    
    console.log("✅ Results saved to API:", res.data);
  } catch (err) {
    console.log(
      "❌ Error sending results to API:",
      err.response?.data || err.message
    );
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
 * Fetch a mining job by ID from the API.
 */
async function fetchJob(jobId) {
  if (!jobId) {
    console.log("❗ MINING_JOB_ID is not set, job will not be fetched.");
    return null;
  }

  try {
    console.log(`📥 Mining job fetch: ${jobId}`);
    const res = await api.get(`/mining/jobs/${jobId}`);
    console.log("✅ Job data:", res.data);
    return res.data.job || res.data;
  } catch (err) {
    console.log("❌ Job fetch error:", err.response?.data || err.message);
    return null;
  }
}

/**
 * Generic email extractor from HTML.
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
 * Guess website from email domain, skipping generic providers.
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
 * Extract exhibitor detail links from HTML.
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
 * Extract meta info from exhibitor detail page.
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
      
      // Website: look for non-shortener, non-social external links
      const anchors = Array.from(document.querySelectorAll("a"));
      for (const a of anchors) {
        const href = (a.getAttribute("href") || "").trim();
        const text = (a.textContent || "").trim().toLowerCase();
        const target = a.getAttribute("target") || "";
        
        if (!href || !href.startsWith("http")) continue;
        
        // Skip if contains exhibition domain or social media
        if (
          href.includes("exhibitors.big5") ||
          href.includes("big5construct") ||
          href.includes("dmg") ||
          href.includes("facebook.com") ||
          href.includes("twitter.com") ||
          href.includes("linkedin.com") ||
          href.includes("instagram.com") ||
          href.includes("youtube.com") ||
          href.includes("pinterest.com") ||
          href.includes("shorturl.at") ||
          href.includes("bit.ly") ||
          href.includes("tinyurl.com")
        ) continue;
        
        // Prioritize links that open in new tab or have "website" text
        if (
          target === "_blank" ||
          text.includes("website") ||
          text.includes("visit") ||
          text.includes("www") ||
          a.parentElement?.textContent?.toLowerCase().includes("website")
        ) {
          result.website = href;
          break;
        }
      }
      
      // Phone extraction - improved regex
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
      
      // Country - expanded selectors
      const countrySelectors = [
        ".country", ".location", ".address .country",
        "[data-field='country']", ".exhibitor-country",
        ".company-country", ".address-country", 
        "td:contains('Country') + td",
        "span:contains('Country:') + span"
      ];
      
      for (const sel of countrySelectors) {
        try {
          // For jQuery-style selectors, use a different approach
          if (sel.includes(":contains")) {
            const elements = Array.from(document.querySelectorAll("td, span"));
            for (const el of elements) {
              if (el.textContent && el.textContent.includes("Country")) {
                const next = el.nextElementSibling;
                if (next && next.textContent) {
                  result.country = next.textContent.trim();
                  break;
                }
              }
            }
          } else {
            const el = document.querySelector(sel);
            if (el && el.textContent) {
              result.country = el.textContent.trim();
              break;
            }
          }
        } catch (e) {
          // Skip invalid selectors
        }
      }
      
      // Contact name - expanded selectors
      const contactSelectors = [
        ".contact-name", ".contact_person", ".contact-person",
        ".person-name", ".representative", ".rep-name",
        "[data-field='contact']", ".exhibitor-contact .name",
        "td:contains('Contact') + td", "strong"
      ];
      
      for (const sel of contactSelectors) {
        try {
          if (sel.includes(":contains")) {
            const elements = Array.from(document.querySelectorAll("td"));
            for (const el of elements) {
              if (el.textContent && el.textContent.includes("Contact")) {
                const next = el.nextElementSibling;
                if (next && next.textContent) {
                  const text = next.textContent.trim();
                  if (text.length > 2 && text.length < 100 &&
                      !text.toLowerCase().includes("contact")) {
                    result.contactName = text;
                    break;
                  }
                }
              }
            }
          } else {
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
          }
        } catch (e) {
          // Skip
        }
      }
      
      // Job title
      const jobSelectors = [
        ".job-title", ".designation", ".position", ".title",
        "[data-field='title']", ".contact-title", ".role",
        "td:contains('Title') + td", "td:contains('Position') + td"
      ];
      
      for (const sel of jobSelectors) {
        try {
          if (sel.includes(":contains")) {
            const elements = Array.from(document.querySelectorAll("td"));
            for (const el of elements) {
              const text = el.textContent || "";
              if (text.includes("Title") || text.includes("Position")) {
                const next = el.nextElementSibling;
                if (next && next.textContent) {
                  const jobText = next.textContent.trim();
                  if (jobText.length > 2 && jobText.length < 100) {
                    result.jobTitle = jobText;
                    break;
                  }
                }
              }
            }
          } else {
            const el = document.querySelector(sel);
            if (el && el.textContent) {
              const text = el.textContent.trim();
              if (text.length > 2 && text.length < 100) {
                result.jobTitle = text;
                break;
              }
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
  
  // Fallback: Try to extract website from HTML if not found
  if (!website) {
    const websiteRegex = /(https?:\/\/(?:www\.)?[A-Z0-9][A-Z0-9\-]{0,61}[A-Z0-9]\.(?:[A-Z0-9\-]{0,61}\.)*[A-Z]{2,})/gi;
    const matches = exHtml.match(websiteRegex) || [];
    
    for (const url of matches) {
      if (!isBlacklistedWebsite(url) &&
          !url.includes("exhibitors") &&
          !url.includes("big5") &&
          !url.includes("dmg") &&
          !url.includes("facebook") &&
          !url.includes("twitter") &&
          !url.includes("linkedin")) {
        website = url;
        break;
      }
    }
  }
  
  // Final fallback: guess from email domain
  if (!website && exEmails && exEmails.length > 0) {
    const guessed = guessWebsiteFromEmail(exEmails);
    if (guessed) {
      website = guessed;
      console.log(`    💡 Website guessed from email: ${website}`);
    }
  }
  
  // Double-check: if website is still a shortener, try email fallback
  if (website && isBlacklistedWebsite(website)) {
    console.log(`    ⚠️ Ignoring blacklisted website: ${website}`);
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
 * Smart pagination handler with multiple strategies
 */
async function getAllExhibitorLinks(page, baseUrl, config = {}) {
  const allExhibitorLinks = [];
  const seenHashes = new Set();
  
  let currentPage = 1;
  const maxPages = config.max_pages || 20;
  const delayMs = config.list_page_delay_ms || 2000;
  const detailPattern = config.detail_url_pattern || "/Exhibitor/ExbDetails/";
  
  console.log("📄 Starting pagination crawler...");
  console.log(`   Config: max_pages=${maxPages}, delay=${delayMs}ms, pattern="${detailPattern}"`);
  
  // Load first page
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  
  // Detect total exhibitors and pagination method
  const paginationInfo = await page.evaluate(() => {
    const result = {
      totalExhibitors: null,
      paginationType: null,
      hasLoadMore: false,
      hasNextButton: false,
      hasPageNumbers: false,
      visiblePageNumbers: [],
      lastPageNumber: 1
    };
    
    // Find total count - more specific pattern for this site
    const bodyText = document.body.innerText || "";
    
    // Look for "Showing X to Y of Z" pattern
    const showingMatch = bodyText.match(/showing\s+(\d+)\s+to\s+(\d+)\s+of\s+(\d+)/i);
    if (showingMatch) {
      result.totalExhibitors = parseInt(showingMatch[3]);
      console.log("Found total via 'showing' pattern:", showingMatch[3]);
    }
    
    // Alternative patterns
    if (!result.totalExhibitors) {
      const patterns = [
        /(\d+)\s+(?:total\s+)?(?:results?|exhibitors?|companies?)/i,
        /total[:\s]+(\d+)/i
      ];
      
      for (const pattern of patterns) {
        const match = bodyText.match(pattern);
        if (match && match[1]) {
          result.totalExhibitors = parseInt(match[1]);
          break;
        }
      }
    }
    
    // Check for "Load More" button
    const loadMoreButtons = Array.from(document.querySelectorAll("button, a"))
      .filter(el => {
        const text = (el.textContent || "").toLowerCase();
        return text.includes("load more") || text.includes("show more");
      });
    result.hasLoadMore = loadMoreButtons.length > 0;
    
    // Check for Next button
    const nextButtons = Array.from(document.querySelectorAll("a, button"))
      .filter(el => {
        const text = (el.textContent || "").toLowerCase().trim();
        const className = (el.className || "").toLowerCase();
        return text === "next" || text === ">" || text === "»" || 
               className.includes("next");
      });
    result.hasNextButton = nextButtons.length > 0;
    
    // Check for page numbers - including hidden ones
    const pageLinks = Array.from(document.querySelectorAll("a, button"));
    
    for (const link of pageLinks) {
      const text = (link.textContent || "").trim();
      const href = link.getAttribute("href") || "";
      
      // Check visible page numbers
      if (/^[1-9]\d*$/.test(text)) {
        const num = parseInt(text);
        if (num > 0 && num < 100) {
          result.visiblePageNumbers.push(num);
          result.lastPageNumber = Math.max(result.lastPageNumber, num);
        }
      }
      
      // Check hrefs for page parameters
      const pageMatch = href.match(/[?&]page=(\d+)/);
      if (pageMatch) {
        const num = parseInt(pageMatch[1]);
        result.lastPageNumber = Math.max(result.lastPageNumber, num);
      }
      
      // Check for "Last" button
      if (text.toLowerCase().includes("last") || text === "»»") {
        const lastMatch = href.match(/[?&]page=(\d+)/);
        if (lastMatch) {
          result.lastPageNumber = Math.max(result.lastPageNumber, parseInt(lastMatch[1]));
        }
      }
    }
    
    result.hasPageNumbers = result.visiblePageNumbers.length > 0;
    
    // Determine pagination type
    if (result.hasLoadMore) {
      result.paginationType = "loadmore";
    } else if (result.hasPageNumbers || result.hasNextButton) {
      result.paginationType = "pages";
    } else {
      result.paginationType = "single";
    }
    
    return result;
  });
  
  console.log(`📊 Pagination detection:`, paginationInfo);
  
  // Calculate expected pages from total exhibitors
  let estimatedPages = 1;
  if (paginationInfo.totalExhibitors) {
    // Assume 24 items per page (common for this type of site)
    estimatedPages = Math.ceil(paginationInfo.totalExhibitors / 24);
    console.log(`📄 Calculated ${estimatedPages} pages from ${paginationInfo.totalExhibitors} total exhibitors (24 per page)`);
  }
  
  // Use the maximum of: detected pages, calculated pages, or force from config
  let totalPages = Math.max(
    paginationInfo.lastPageNumber,
    estimatedPages,
    config.force_page_count || 1
  );
  
  // Apply max_pages limit
  totalPages = Math.min(totalPages, maxPages);
  
  console.log(`📖 Will crawl ${totalPages} pages`);
  
  // Strategy based on pagination type
  if (paginationInfo.paginationType === "loadmore") {
    // Handle "Load More" style pagination
    console.log("⚡ Using Load More strategy");
    
    let previousCount = 0;
    let attempts = 0;
    
    while (attempts < totalPages) {
      const links = extractExhibitorLinks(await page.content(), baseUrl, config);
      const currentCount = links.length;
      
      if (currentCount === previousCount) {
        console.log(`  ✅ No new exhibitors after Load More, total: ${links.length}`);
        allExhibitorLinks.push(...links);
        break;
      }
      
      previousCount = currentCount;
      
      // Try to click Load More
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button, a"))
          .filter(el => {
            const text = (el.textContent || "").toLowerCase();
            return text.includes("load more") || text.includes("show more");
          });
        
        if (buttons.length > 0 && !buttons[0].disabled) {
          buttons[0].click();
          return true;
        }
        return false;
      });
      
      if (!clicked) {
        console.log(`  ✅ Load More button not available, total: ${links.length}`);
        allExhibitorLinks.push(...links);
        break;
      }
      
      console.log(`  ⏳ Clicked Load More, waiting for new content...`);
      await page.waitForTimeout(delayMs);
      attempts++;
    }
    
  } else {
    // Handle traditional pagination (pages or next button)
    console.log(`⚡ Using traditional pagination strategy for ${totalPages} pages`);
    
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      if (pageNum > 1) {
        // Method 1: Try URL parameter first
        const paramUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}page=${pageNum}`;
        
        let loaded = false;
        
        try {
          console.log(`  🔄 Loading page ${pageNum} via URL: ${paramUrl}`);
          await page.goto(paramUrl, { waitUntil: "networkidle", timeout: 15000 });
          
          // Check if we got new content
          const links = extractExhibitorLinks(await page.content(), baseUrl, config);
          if (links.length > 0) {
            const hash = links.slice(0, 5).sort().join("|"); // Use first 5 links as signature
            if (!seenHashes.has(hash)) {
              seenHashes.add(hash);
              allExhibitorLinks.push(...links);
              console.log(`  ✅ Page ${pageNum}: found ${links.length} exhibitors (URL method)`);
              loaded = true;
            } else {
              console.log(`  ⚠️ Page ${pageNum} has duplicate content`);
            }
          }
        } catch (e) {
          console.log(`  ⚠️ Failed to load page ${pageNum} via URL: ${e.message}`);
        }
        
        // Method 2: If URL didn't work, try clicking page number
        if (!loaded) {
          try {
            // Go back to a known good page first
            if (pageNum === 2) {
              await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 15000 });
            }
            
            const clicked = await page.evaluate((num) => {
              // Try to find and click the page number
              const links = Array.from(document.querySelectorAll("a, button"));
              for (const link of links) {
                const text = (link.textContent || "").trim();
                if (text === String(num)) {
                  link.click();
                  return true;
                }
              }
              
              // If exact number not found, try Next button
              if (num > 1) {
                for (const link of links) {
                  const text = (link.textContent || "").toLowerCase().trim();
                  if (text === "next" || text === ">" || text === "»") {
                    link.click();
                    return true;
                  }
                }
              }
              
              return false;
            }, pageNum);
            
            if (clicked) {
              await page.waitForTimeout(delayMs * 1.5); // Extra wait for click navigation
              const links = extractExhibitorLinks(await page.content(), baseUrl, config);
              const hash = links.slice(0, 5).sort().join("|");
              
              if (!seenHashes.has(hash) && links.length > 0) {
                seenHashes.add(hash);
                allExhibitorLinks.push(...links);
                console.log(`  ✅ Page ${pageNum}: found ${links.length} exhibitors (click method)`);
                loaded = true;
              }
            }
          } catch (e) {
            console.log(`  ⚠️ Failed to click page ${pageNum}: ${e.message}`);
          }
        }
        
        // Method 3: Force sequential Next clicking
        if (!loaded && pageNum <= totalPages) {
          console.log(`  ⚠️ Could not load page ${pageNum}, trying sequential navigation...`);
          
          // Reset to page 1 and click Next (pageNum-1) times
          try {
            await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 15000 });
            
            for (let i = 1; i < pageNum; i++) {
              const nextClicked = await page.evaluate(() => {
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
              
              if (!nextClicked) break;
              await page.waitForTimeout(delayMs);
            }
            
            const links = extractExhibitorLinks(await page.content(), baseUrl, config);
            const hash = links.slice(0, 5).sort().join("|");
            
            if (!seenHashes.has(hash) && links.length > 0) {
              seenHashes.add(hash);
              allExhibitorLinks.push(...links);
              console.log(`  ✅ Page ${pageNum}: found ${links.length} exhibitors (sequential method)`);
              loaded = true;
            }
          } catch (e) {
            console.log(`  ⚠️ Sequential navigation failed: ${e.message}`);
          }
        }
        
        if (!loaded) {
          console.log(`  ❌ Failed to load page ${pageNum} with all methods`);
        }
        
        await page.waitForTimeout(delayMs);
      } else {
        // First page
        const links = extractExhibitorLinks(await page.content(), baseUrl, config);
        const hash = links.slice(0, 5).sort().join("|");
        seenHashes.add(hash);
        allExhibitorLinks.push(...links);
        console.log(`  ✅ Page 1: found ${links.length} exhibitors`);
      }
    }
  }
  
  // Remove duplicates and report
  const uniqueLinks = Array.from(new Set(allExhibitorLinks));
  console.log(`\n✅ Total unique exhibitor links collected: ${uniqueLinks.length}`);
  
  if (paginationInfo.totalExhibitors && uniqueLinks.length < paginationInfo.totalExhibitors * 0.8) {
    console.log(`⚠️ Warning: Expected ~${paginationInfo.totalExhibitors} but found ${uniqueLinks.length}`);
    console.log(`   Some pages might have failed to load. Consider using force_page_count in config.`);
  }
  
  return uniqueLinks;
}

/**
 * Main mining routine
 */
async function runPlaywrightStrategy(job) {
  const url = job.input;
  const config = job.config || {};
  
  console.log(`🌐 Launching browser for: ${url}`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const allResults = [];
  
  try {
    const exhibitorLinks = await getAllExhibitorLinks(page, url, config);
    
    if (exhibitorLinks.length === 0) {
      console.log("⚠️ No exhibitor links found");
      await browser.close();
      return;
    }
    
    console.log("\n🏢 Sample links:", exhibitorLinks.slice(0, 5));
    console.log(`\n🔎 Visiting ${exhibitorLinks.length} detail pages...`);
    
    const startTime = Date.now();
    
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
    
    // Summary
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
    
    // Prepare summary object for API
    const summary = {
      total_exhibitors: exhibitorLinks.length,
      total_results: allResults.length,
      total_emails: totalEmails,
      exhibitors_with_emails: emailsFound.length,
      websites_found: websitesFound.length,
      contacts_found: contactsFound.length,
      time_minutes: parseFloat(totalTime)
    };
    
    // Send results to API
    await sendResultsToApi(job, allResults, summary);
    
    // Top results
    const withEmails = allResults.filter(r => r.emails?.length > 0).slice(0, 10);
    if (withEmails.length > 0) {
      console.log("\n📋 Sample results:");
      withEmails.forEach((r, i) => {
        console.log(`\n  ${i + 1}. ${r.companyName || "Unknown"}`);
        console.log(`     📧 ${r.emails.join(", ")}`);
        if (r.website) console.log(`     🌐 ${r.website}`);
      });
    }
    
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
  
  const job = await fetchJob(JOB_ID);
  
  if (!job) {
    console.log("❌ No job found");
    return;
  }
  
  const strategy = job.strategy || "auto";
  const config = job.config || {};
  
  console.log(`⚙️ Job strategy: ${strategy}`);
  console.log(`⚙️ Job config:`, config);
  
  if (strategy === "http") {
    console.log("⚠️ HTTP-only strategy not implemented yet. Use 'auto' or 'playwright' for now.");
    return;
  }
  
  // For now: 'auto' and 'playwright' both use Playwright strategy
  await runPlaywrightStrategy(job);
  
  console.log(`\n📅 Completed: ${new Date().toLocaleString()}`);
  console.log("⛏️ Mining Worker finished");
}

module.exports = { runMiningTest };
