/**
 * LIFFY Directory Miner v1.0 (Backend Integration)
 * =================================================
 *
 * Copied from liffy-local-miner/miners/directoryMiner.js (Step 9 Phase 1).
 * Modifications:
 *   - Removed normalize.js dependency (canonical normalizer handles this)
 *   - Returns raw card data instead of normalized results
 *   - Removed CLI entry point (browser lifecycle managed by flowOrchestrator wrapper)
 *
 * Two-phase pipeline:
 *   1. List page crawl — detect business cards, paginate
 *   2. Detail page visits — enrich with email, website, phone, address
 *
 * Usage (module only):
 *   const { runDirectoryMiner } = require("./directoryMiner");
 *   const cards = await runDirectoryMiner(page, url, config);
 */

// ─── Constants ───────────────────────────────────────────────────────

const EMAIL_REGEX = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;

const PHONE_REGEX = /(?:\+?\d{1,4}[\s\-.]?)?\(?\d{1,5}\)?[\s\-.]?\d{2,5}[\s\-.]?\d{2,5}(?:[\s\-.]?\d{1,5})?/g;

const SOCIAL_HOSTS = [
  "facebook.com", "twitter.com", "linkedin.com", "instagram.com",
  "youtube.com", "pinterest.com", "tiktok.com", "x.com",
  "vimeo.com", "flickr.com", "wa.me", "whatsapp.com", "web.whatsapp.com",
  "t.me", "telegram.org", "reddit.com", "snapchat.com"
];

const MAP_HOSTS = [
  "google.com/maps", "goo.gl/maps", "maps.google",
  "maps.app.goo.gl", "waze.com", "openstreetmap.org"
];

const GENERIC_HOSTS = [
  "google.com", "bing.com", "yahoo.com", "apple.com",
  "microsoft.com", "amazonaws.com", "cloudflare.com",
  "w3.org", "schema.org", "gravatar.com"
];

// ─── Helpers ─────────────────────────────────────────────────────────

function getSiteDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch (e) {
    return null;
  }
}

function makeAbsoluteUrl(href, baseUrl) {
  if (!href) return null;
  try {
    if (href.startsWith("http")) return href;
    const base = new URL(baseUrl);
    if (href.startsWith("/")) {
      return `${base.protocol}//${base.host}${href}`;
    }
    return new URL(href, baseUrl).href;
  } catch (e) {
    return null;
  }
}

function isExternalWebsite(href, siteDomain) {
  if (!href) return false;
  try {
    const u = new URL(href);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    // Same site
    if (host === siteDomain || host.endsWith("." + siteDomain)) return false;
    // Social media
    if (SOCIAL_HOSTS.some(s => host === s || host.endsWith("." + s))) return false;
    // Map services
    if (MAP_HOSTS.some(m => href.toLowerCase().includes(m))) return false;
    // Generic
    if (GENERIC_HOSTS.some(g => host === g || host.endsWith("." + g))) return false;
    // Must be http/https
    if (!u.protocol.startsWith("http")) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function cleanPhoneFromText(text) {
  if (!text || typeof text !== "string") return null;
  const cleaned = text.replace(/^(tel:|phone:|mobile:|cell:|fax:|call:)/i, "").trim();
  const digits = cleaned.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 16) return null;
  return cleaned;
}

function decodeObfuscatedEmail(text) {
  // Common obfuscation: "user [at] domain [dot] com"
  let decoded = text
    .replace(/\s*\[\s*at\s*\]\s*/gi, "@")
    .replace(/\s*\(\s*at\s*\)\s*/gi, "@")
    .replace(/\s*\{\s*at\s*\}\s*/gi, "@")
    .replace(/\s+at\s+/gi, "@")
    .replace(/\s*\[\s*dot\s*\]\s*/gi, ".")
    .replace(/\s*\(\s*dot\s*\)\s*/gi, ".")
    .replace(/\s*\{\s*dot\s*\}\s*/gi, ".");

  const match = decoded.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}

// ─── Phase 1: List Page Scraping ─────────────────────────────────────

/**
 * Detect repeated card-like structures on the page.
 * Returns raw card data extracted inside the browser context.
 */
async function extractBusinessCards(page, siteDomain, detailPattern) {
  return await page.evaluate(({ siteDomain, detailPattern }) => {
    const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
    const PHONE_RE = /(?:\+?\d{1,4}[\s\-.]?)?\(?\d{1,5}\)?[\s\-.]?\d{2,5}[\s\-.]?\d{2,5}(?:[\s\-.]?\d{1,5})?/g;

    // ── Step 1: Find repeated containers ──
    // Strategy A: known directory selectors
    const dirSelectors = [
      // Exact class matches for common directory sites
      ".company", ".business", ".listing", ".vendor",
      // Compound class patterns
      ".business-card", ".listing-card", ".company-card", ".company-item",
      ".listing-item", ".result-item", ".search-result", ".directory-item",
      ".business-listing", ".biz-card", ".company-listing",
      ".listing-result", ".cat-item", ".lender", ".vendor-card",
      ".list-group-item", ".card", "article.listing", "article.company",
      ".yp-listing", ".yellow-item", ".profile-card",
      "[itemtype*='LocalBusiness']", "[itemtype*='Organization']"
    ];

    let cards = [];
    let usedSelector = null;

    for (const sel of dirSelectors) {
      try {
        const found = document.querySelectorAll(sel);
        if (found.length > cards.length && found.length >= 2) {
          cards = Array.from(found);
          usedSelector = sel;
        }
      } catch (e) {}
    }

    // Strategy B: Repeated parent detection — find blocks that contain phone or address text
    if (cards.length < 2) {
      const allElements = document.querySelectorAll("div, li, article, section, tr");
      const parentCounts = new Map();

      for (const el of allElements) {
        const text = (el.innerText || "").trim();
        if (text.length < 20 || text.length > 2000) continue;

        // Must contain something that looks like a phone or address
        const hasPhone = PHONE_RE.test(text);
        const hasAddress = /\b(street|road|ave|blvd|box|suite|floor|building|city|town)\b/i.test(text) ||
                           /\d{3,}[\s,]/.test(text); // numbers that look like addresses

        if (!hasPhone && !hasAddress) continue;

        // Group by tag+className combo
        const key = el.tagName + "|" + (el.className || "").split(/\s+/).sort().join(".");
        if (!parentCounts.has(key)) parentCounts.set(key, []);
        parentCounts.get(key).push(el);
      }

      for (const [key, elements] of parentCounts) {
        if (elements.length > cards.length && elements.length >= 2) {
          cards = elements;
          usedSelector = "repeated:" + key;
        }
      }
    }

    // ── Step 2: Extract data from each card ──
    const results = [];

    for (const card of cards) {
      const data = {
        company_name: null,
        phone: null,
        address: null,
        detail_url: null,
        email: null,
        website: null,
        country: null
      };

      const cardText = (card.innerText || card.textContent || "").trim();

      // ── Company name + detail URL (linked heading strategy) ──
      // Priority: heading > a links (e.g. div.company_header > h3 > a)
      const headingLinkSelectors = [
        "h3 > a[href]", "h2 > a[href]", "h4 > a[href]", "h1 > a[href]", "h5 > a[href]",
        "[class*='header'] a[href]", "[class*='name'] a[href]", "[class*='title'] a[href]"
      ];
      for (const sel of headingLinkSelectors) {
        if (data.company_name) break;
        try {
          const el = card.querySelector(sel);
          if (el) {
            const t = el.textContent.trim();
            if (t.length >= 2 && t.length <= 150 && !t.includes("@") && !PHONE_RE.test(t)) {
              data.company_name = t;
              // Also grab the detail URL from this link
              const href = el.getAttribute("href") || "";
              if (href && href !== "#" && !href.startsWith("tel:") && !href.startsWith("mailto:")) {
                data.detail_url = href;
              }
            }
          }
        } catch (e) {}
      }

      // Fallback: heading text (without link)
      if (!data.company_name) {
        const nameEls = card.querySelectorAll("h1, h2, h3, h4, h5, .company-name, .business-name, .listing-name, .name, a.title, strong, b");
        for (const el of nameEls) {
          const t = el.textContent.trim();
          if (t.length >= 2 && t.length <= 150 && !t.includes("@") && !PHONE_RE.test(t)) {
            data.company_name = t;
            break;
          }
        }
      }

      // Last resort: first link with substantial text
      if (!data.company_name) {
        const links = card.querySelectorAll("a[href]");
        for (const a of links) {
          const t = a.textContent.trim();
          if (t.length >= 3 && t.length <= 150 && !t.includes("@")) {
            data.company_name = t;
            if (!data.detail_url) {
              const href = a.getAttribute("href") || "";
              if (href && href !== "#" && !href.startsWith("tel:") && !href.startsWith("mailto:")) {
                data.detail_url = href;
              }
            }
            break;
          }
        }
      }

      // ── Phone ──
      // Helper: clean phone string (strip trailing year/junk from multiline text)
      const cleanPhone = (raw) => {
        if (!raw) return null;
        // Take only first line, strip non-phone trailing content
        const firstLine = raw.split(/[\n\r]/)[0].trim();
        const digits = firstLine.replace(/\D/g, "");
        if (digits.length >= 7 && digits.length <= 16) return firstLine;
        return null;
      };

      // 1. tel: links
      const telLink = card.querySelector("a[href^='tel:']");
      if (telLink) {
        data.phone = cleanPhone((telLink.getAttribute("href") || "").replace("tel:", ""));
      }
      // 2. Class-based phone elements
      if (!data.phone) {
        const phoneLabel = card.querySelector(".phone, .telephone, .tel, [class*='phone'], [class*='tel'], [itemprop='telephone']");
        if (phoneLabel) {
          const t = phoneLabel.textContent.trim();
          const m = t.match(PHONE_RE);
          if (m) data.phone = cleanPhone(m[0]);
        }
      }
      // 3. Regex fallback on full card text
      if (!data.phone) {
        const m = cardText.match(PHONE_RE);
        if (m) {
          for (const ph of m) {
            const cleaned = cleanPhone(ph);
            if (cleaned) { data.phone = cleaned; break; }
          }
        }
      }

      // ── Address ──
      const addrEls = card.querySelectorAll(
        "[itemprop='address'], [itemtype*='PostalAddress'], .address, .location, .addr, [class*='address'], [class*='location']"
      );
      for (const el of addrEls) {
        const t = el.textContent.trim().replace(/\s+/g, " ");
        if (t.length >= 5 && t.length <= 300) {
          data.address = t;
          break;
        }
      }

      // Email: mailto links or visible text
      const mailtoLink = card.querySelector("a[href^='mailto:']");
      if (mailtoLink) {
        data.email = (mailtoLink.getAttribute("href") || "").replace(/^mailto:/i, "").split("?")[0].trim().toLowerCase();
      }
      if (!data.email) {
        const dataEmail = card.querySelector("[data-email]");
        if (dataEmail) {
          data.email = (dataEmail.getAttribute("data-email") || "").trim().toLowerCase();
        }
      }
      if (!data.email) {
        const m = cardText.match(EMAIL_RE);
        if (m) data.email = m[0].toLowerCase();
      }

      // Website: external link (not the directory itself)
      const allLinks = card.querySelectorAll("a[href^='http']");
      for (const a of allLinks) {
        const href = a.getAttribute("href") || "";
        try {
          const host = new URL(href).hostname.toLowerCase().replace(/^www\./, "");
          if (host !== siteDomain && !host.endsWith("." + siteDomain)) {
            // Not social or maps
            const socialHosts = ["facebook.com","twitter.com","linkedin.com","instagram.com","youtube.com","x.com","google.com","wa.me","whatsapp.com","t.me","telegram.org"];
            const isSocial = socialHosts.some(s => host === s || host.endsWith("." + s));
            if (!isSocial && !href.includes("maps.google") && !href.includes("goo.gl/maps")) {
              data.website = href;
              break;
            }
          }
        } catch (e) {}
      }

      // ── Detail URL ──
      // 1. Config pattern match
      if (!data.detail_url && detailPattern) {
        const patternLinks = card.querySelectorAll(`a[href*="${detailPattern}"]`);
        if (patternLinks.length > 0) {
          data.detail_url = patternLinks[0].getAttribute("href");
        }
      }
      // 2. "View Profile" / "View" / "Details" / "More Info" links
      if (!data.detail_url) {
        const allCardLinks = card.querySelectorAll("a[href]");
        for (const a of allCardLinks) {
          const text = (a.textContent || "").trim().toLowerCase();
          if (/^(view\s*(profile|details|more)?|details|more\s*info|profile|see\s*more)$/i.test(text)) {
            const href = a.getAttribute("href") || "";
            if (href && href !== "#" && !href.startsWith("tel:") && !href.startsWith("mailto:")) {
              data.detail_url = href;
              break;
            }
          }
        }
      }
      // 3. Generic internal link fallback
      if (!data.detail_url) {
        const internalLinks = card.querySelectorAll("a[href]");
        for (const a of internalLinks) {
          const href = a.getAttribute("href") || "";
          if (href.startsWith("http") && !href.includes(window.location.hostname)) continue;
          if (href.startsWith("#") || href.startsWith("tel:") || href.startsWith("mailto:")) continue;
          if (href === "/" || href === "") continue;
          const pathParts = href.replace(/^\//, "").split("/").filter(Boolean);
          if (pathParts.length >= 1) {
            data.detail_url = href;
            break;
          }
        }
      }

      // Country: class-based or flag
      const countryEl = card.querySelector(".country, [class*='country'], [data-country]");
      if (countryEl) {
        data.country = countryEl.textContent.trim();
      }

      // Only include if we have at least a company name
      if (data.company_name) {
        results.push(data);
      }
    }

    return { results, selector: usedSelector, cardCount: cards.length };
  }, { siteDomain, detailPattern: detailPattern || null });
}

/**
 * Navigate to the next page (pagination).
 * Tries URL patterns first, then click-based.
 */
async function goToNextPage(page, baseUrl, currentPage) {
  // Method 1: URL parameter patterns
  const currentUrl = page.url();
  const urlPatterns = [];

  // ?page=N or &page=N
  if (currentUrl.includes("page=")) {
    urlPatterns.push(currentUrl.replace(/page=\d+/, `page=${currentPage + 1}`));
  } else {
    urlPatterns.push(
      `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}page=${currentPage + 1}`
    );
  }

  // /page/N/ path pattern
  if (currentUrl.match(/\/page\/\d+/)) {
    urlPatterns.push(currentUrl.replace(/\/page\/\d+/, `/page/${currentPage + 1}`));
  }

  for (const url of urlPatterns) {
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      if (response && response.ok()) {
        await page.waitForLoadState("networkidle").catch(() => {});
        return true;
      }
    } catch (e) {}
  }

  // Method 2: Click next button / page number
  try {
    const clicked = await page.evaluate((nextPageNum) => {
      // Next button selectors
      const nextSelectors = [
        "a.next", "button.next", ".pagination .next", "a[rel='next']",
        "[aria-label='Next']", ".pagination-next", "a.next-page",
        ".pager-next a", ".page-next a"
      ];
      for (const sel of nextSelectors) {
        try {
          const el = document.querySelector(sel);
          if (el && !el.classList.contains("disabled")) { el.click(); return true; }
        } catch (e) {}
      }

      // Page number click
      const allLinks = document.querySelectorAll(".pagination a, .pager a, nav a, .page-numbers a");
      for (const link of allLinks) {
        const text = (link.textContent || "").trim();
        if (text === String(nextPageNum)) { link.click(); return true; }
      }

      // Text-based: "Next", ">", ">>", etc
      const buttons = document.querySelectorAll("a, button");
      for (const btn of buttons) {
        const text = (btn.textContent || "").trim().toLowerCase();
        if (text === "next" || text === ">" || text === ">>" || text === "\u00bb" || text === "\u2192") {
          if (!btn.classList.contains("disabled") && !btn.hasAttribute("disabled")) {
            btn.click();
            return true;
          }
        }
      }

      return false;
    }, currentPage + 1);

    if (clicked) {
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(1000);
      return true;
    }
  } catch (e) {}

  return false;
}

/**
 * Phase 1: Crawl all list pages and collect business cards.
 */
async function crawlListPages(page, baseUrl, config = {}) {
  const maxPages = config.max_pages || 10;
  const delayMs = config.delay_ms || 1000;
  const detailPattern = config.detail_url_pattern || null;
  const siteDomain = config.site_domain || getSiteDomain(baseUrl);

  const allCards = [];
  const seenNames = new Set();
  let emptyStreak = 0;

  console.log(`\n   [directoryMiner] Phase 1: List page crawl`);
  console.log(`   [directoryMiner] Max pages: ${maxPages}, Delay: ${delayMs}ms`);
  console.log(`   [directoryMiner] Site domain: ${siteDomain}`);

  // Load first page
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle").catch(() => {});
  } catch (e) {
    console.log(`   [directoryMiner] Failed to load: ${e.message}`);
    return allCards;
  }

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    console.log(`   [directoryMiner] Page ${pageNum}/${maxPages}...`);

    const { results, selector, cardCount } = await extractBusinessCards(page, siteDomain, detailPattern);

    if (pageNum === 1) {
      console.log(`   [directoryMiner] Detected ${cardCount} cards via: ${selector || "none"}`);
    }

    let newCount = 0;
    for (const card of results) {
      const key = (card.company_name || "").toLowerCase().trim();
      if (key && !seenNames.has(key)) {
        seenNames.add(key);
        // Resolve detail URL to absolute
        card.detail_url = makeAbsoluteUrl(card.detail_url, page.url());
        card.website = card.website ? makeAbsoluteUrl(card.website, page.url()) : null;
        allCards.push(card);
        newCount++;
      }
    }

    console.log(`   [directoryMiner] +${newCount} new (total: ${allCards.length})`);

    if (newCount === 0) {
      emptyStreak++;
      if (emptyStreak >= 2) {
        console.log(`   [directoryMiner] 2 consecutive empty pages, stopping`);
        break;
      }
    } else {
      emptyStreak = 0;
    }

    // Navigate to next page
    if (pageNum < maxPages) {
      const hasNext = await goToNextPage(page, baseUrl, pageNum);
      if (!hasNext) {
        console.log(`   [directoryMiner] No next page found, stopping`);
        break;
      }
      await page.waitForTimeout(delayMs);
    }
  }

  return allCards;
}

// ─── Phase 2: Detail Page Visiting ───────────────────────────────────

/**
 * Extract email, website, phone, and address from a single detail page.
 */
async function scrapeDetailPage(page, url, siteDomain) {
  const data = {
    emails: [],
    website: null,
    phones: [],
    address: null,
    country: null
  };

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForLoadState("networkidle").catch(() => {});
  } catch (e) {
    // Try a lighter wait
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    } catch (e2) {
      return data;
    }
  }

  const extracted = await page.evaluate((siteDomain) => {
    const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
    const PHONE_RE = /(?:\+?\d{1,4}[\s\-.]?)?\(?\d{1,5}\)?[\s\-.]?\d{2,5}[\s\-.]?\d{2,5}(?:[\s\-.]?\d{1,5})?/g;
    const result = { emails: [], website: null, phones: [], address: null, country: null };

    const bodyText = document.body ? (document.body.innerText || "") : "";

    // ── Emails ──
    // 1. mailto: links
    const mailtoLinks = document.querySelectorAll("a[href^='mailto:']");
    for (const a of mailtoLinks) {
      const email = (a.getAttribute("href") || "").replace(/^mailto:/i, "").split("?")[0].trim().toLowerCase();
      if (email && email.includes("@")) result.emails.push(email);
    }

    // 2. data-email attributes
    const dataEmailEls = document.querySelectorAll("[data-email], [data-mail]");
    for (const el of dataEmailEls) {
      const email = (el.getAttribute("data-email") || el.getAttribute("data-mail") || "").trim().toLowerCase();
      if (email && email.includes("@")) result.emails.push(email);
    }

    // 3. Text-based email regex
    const textEmails = bodyText.match(EMAIL_RE) || [];
    for (const e of textEmails) {
      result.emails.push(e.toLowerCase());
    }

    // 4. Obfuscated email (user [at] domain [dot] com)
    const obfuscatedPattern = /[a-z0-9._%+\-]+\s*[\[\(\{]\s*at\s*[\]\)\}]\s*[a-z0-9.\-]+\s*[\[\(\{]\s*dot\s*[\]\)\}]\s*[a-z]{2,}/gi;
    const obfMatches = bodyText.match(obfuscatedPattern) || [];
    for (const m of obfMatches) {
      const decoded = m
        .replace(/\s*[\[\(\{]\s*at\s*[\]\)\}]\s*/gi, "@")
        .replace(/\s*[\[\(\{]\s*dot\s*[\]\)\}]\s*/gi, ".");
      if (decoded.includes("@")) result.emails.push(decoded.toLowerCase());
    }

    // 5. Reverse-text emails (CSS direction:rtl trick)
    const rtlEls = document.querySelectorAll("[style*='direction'], [style*='unicode-bidi'], .email-protect");
    for (const el of rtlEls) {
      const raw = el.textContent.trim();
      const reversed = raw.split("").reverse().join("");
      const rm = reversed.match(EMAIL_RE);
      if (rm) result.emails.push(rm[0].toLowerCase());
    }

    // Deduplicate emails
    result.emails = [...new Set(result.emails)];

    // ── Website ──
    // Look for external links, skip social/maps/directory
    const socialHosts = ["facebook.com","twitter.com","linkedin.com","instagram.com","youtube.com","x.com","pinterest.com","tiktok.com","wa.me","whatsapp.com","t.me","telegram.org","google.com"];
    const websiteSelectors = [
      "a[href^='http'][rel*='external']",
      "a[href^='http'][target='_blank']",
      ".website a[href^='http']", ".url a[href^='http']",
      "[itemprop='url']", "a.website", "a.web-link"
    ];

    // Label-based: find "Website:" or "Web:" text then grab adjacent link
    const allElements = document.querySelectorAll("dt, th, label, span, strong, b, div");
    for (const el of allElements) {
      const t = (el.textContent || "").trim().toLowerCase();
      if (t === "website" || t === "website:" || t === "web:" || t === "web" || t === "url:" || t === "homepage:") {
        // Check next sibling or parent's next element
        const next = el.nextElementSibling || (el.parentElement && el.parentElement.nextElementSibling);
        if (next) {
          const link = next.querySelector ? (next.querySelector("a[href^='http']") || next) : next;
          const href = link.getAttribute ? (link.getAttribute("href") || link.textContent.trim()) : "";
          if (href && href.startsWith("http")) {
            try {
              const host = new URL(href).hostname.toLowerCase().replace(/^www\./, "");
              if (host !== siteDomain && !host.endsWith("." + siteDomain)) {
                const isSocial = socialHosts.some(s => host === s || host.endsWith("." + s));
                if (!isSocial) {
                  result.website = href;
                }
              }
            } catch (e) {}
          }
        }
      }
    }

    // Fallback: selector-based
    if (!result.website) {
      for (const sel of websiteSelectors) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            const href = el.getAttribute("href") || "";
            try {
              const host = new URL(href).hostname.toLowerCase().replace(/^www\./, "");
              if (host !== siteDomain && !host.endsWith("." + siteDomain)) {
                const isSocial = socialHosts.some(s => host === s || host.endsWith("." + s));
                if (!isSocial && !href.includes("maps.google") && !href.includes("goo.gl/maps")) {
                  result.website = href;
                  break;
                }
              }
            } catch (e) {}
          }
          if (result.website) break;
        } catch (e) {}
      }
    }

    // ── Phones ──
    // 1. tel: links
    const telLinks = document.querySelectorAll("a[href^='tel:']");
    for (const a of telLinks) {
      const ph = (a.getAttribute("href") || "").replace("tel:", "").trim();
      if (ph) result.phones.push(ph);
    }

    // 2. Label-based: "Phone:", "Tel:", "Mobile:", "Call:"
    for (const el of allElements) {
      const t = (el.textContent || "").trim().toLowerCase();
      if (/^(phone|tel|telephone|mobile|call|fax|gsm):?$/.test(t)) {
        const next = el.nextElementSibling || (el.parentElement && el.parentElement.nextElementSibling);
        if (next) {
          const nextText = (next.textContent || "").trim();
          const m = nextText.match(PHONE_RE);
          if (m) {
            for (const ph of m) {
              const digits = ph.replace(/\D/g, "");
              if (digits.length >= 7) result.phones.push(ph);
            }
          }
        }
      }
    }

    // 3. Class-based
    const phoneEls = document.querySelectorAll(".phone, .telephone, .tel, [itemprop='telephone'], [class*='phone']");
    for (const el of phoneEls) {
      const m = (el.textContent || "").match(PHONE_RE);
      if (m) {
        for (const ph of m) {
          const digits = ph.replace(/\D/g, "");
          if (digits.length >= 7) result.phones.push(ph);
        }
      }
    }

    // Deduplicate phones
    result.phones = [...new Set(result.phones)];

    // ── Address ──
    // 1. Schema.org / microdata
    const addrEl = document.querySelector("[itemprop='address'], [itemtype*='PostalAddress']");
    if (addrEl) {
      result.address = addrEl.textContent.trim().replace(/\s+/g, " ");
    }

    // 2. JSON-LD
    if (!result.address) {
      try {
        const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of ldScripts) {
          const json = JSON.parse(script.textContent);
          const findAddr = (obj) => {
            if (!obj || typeof obj !== "object") return null;
            if (obj.address) {
              if (typeof obj.address === "string") return obj.address;
              const parts = [obj.address.streetAddress, obj.address.addressLocality, obj.address.addressRegion, obj.address.postalCode, obj.address.addressCountry].filter(Boolean);
              if (parts.length > 0) return parts.join(", ");
            }
            for (const key of Object.keys(obj)) {
              if (typeof obj[key] === "object") {
                const found = findAddr(obj[key]);
                if (found) return found;
              }
            }
            return null;
          };
          const found = findAddr(json);
          if (found) { result.address = found; break; }
        }
      } catch (e) {}
    }

    // 3. Class/label-based
    if (!result.address) {
      const addrEls = document.querySelectorAll(".address, [class*='address'], .location, [class*='location']");
      for (const el of addrEls) {
        const t = el.textContent.trim().replace(/\s+/g, " ");
        if (t.length >= 10 && t.length <= 300) {
          result.address = t;
          break;
        }
      }
    }

    // 4. Label-based
    if (!result.address) {
      for (const el of allElements) {
        const t = (el.textContent || "").trim().toLowerCase();
        if (t === "address" || t === "address:" || t === "location:" || t === "location") {
          const next = el.nextElementSibling || (el.parentElement && el.parentElement.nextElementSibling);
          if (next) {
            const addr = (next.textContent || "").trim().replace(/\s+/g, " ");
            if (addr.length >= 10 && addr.length <= 300) {
              result.address = addr;
              break;
            }
          }
        }
      }
    }

    // ── Country ──
    // From JSON-LD addressCountry
    if (!result.country) {
      try {
        const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of ldScripts) {
          const json = JSON.parse(script.textContent);
          const findCountry = (obj) => {
            if (!obj || typeof obj !== "object") return null;
            if (obj.addressCountry) return obj.addressCountry;
            if (obj.address && obj.address.addressCountry) return obj.address.addressCountry;
            for (const key of Object.keys(obj)) {
              if (typeof obj[key] === "object") {
                const found = findCountry(obj[key]);
                if (found) return found;
              }
            }
            return null;
          };
          const found = findCountry(json);
          if (found) { result.country = found; break; }
        }
      } catch (e) {}
    }

    // From class
    if (!result.country) {
      const countryEl = document.querySelector(".country, [class*='country'], [data-country], [itemprop='addressCountry']");
      if (countryEl) {
        const t = (countryEl.getAttribute("data-country") || countryEl.textContent || "").trim();
        if (t.length >= 2 && t.length <= 60) result.country = t;
      }
    }

    return result;
  }, siteDomain);

  data.emails = extracted.emails || [];
  data.website = extracted.website;
  data.phones = extracted.phones || [];
  data.address = extracted.address;
  data.country = extracted.country;

  return data;
}

/**
 * Phase 2: Visit detail pages and enrich card data.
 */
async function enrichWithDetailPages(page, cards, config = {}) {
  const maxDetails = config.max_details || 200;
  const delayMs = config.delay_ms || 1000;
  const siteDomain = config.site_domain || null;

  const toVisit = cards.filter(c => c.detail_url).slice(0, maxDetails);
  console.log(`\n   [directoryMiner] Phase 2: Detail page visits (${toVisit.length}/${cards.length} have URLs)`);

  if (toVisit.length === 0) {
    console.log(`   [directoryMiner] No detail URLs found, skipping phase 2`);
    return;
  }

  let enriched = 0;

  for (let i = 0; i < toVisit.length; i++) {
    const card = toVisit[i];

    if ((i + 1) % 10 === 0 || i === 0) {
      console.log(`   [directoryMiner] [${i + 1}/${toVisit.length}] ${card.company_name || "?"}`);
    }

    try {
      const detail = await scrapeDetailPage(page, card.detail_url, siteDomain);

      // Merge detail data into card
      let changed = false;

      if (detail.emails.length > 0 && !card.email) {
        card.email = detail.emails[0];
        card.all_emails = detail.emails;
        changed = true;
      } else if (detail.emails.length > 0) {
        // Merge emails
        const existing = card.all_emails || (card.email ? [card.email] : []);
        const merged = [...new Set([...existing, ...detail.emails])];
        card.all_emails = merged;
        if (!card.email) card.email = merged[0];
        changed = true;
      }

      if (detail.website && !card.website) {
        card.website = detail.website;
        changed = true;
      }

      if (detail.phones.length > 0 && !card.phone) {
        card.phone = detail.phones[0];
        changed = true;
      }

      if (detail.address && !card.address) {
        card.address = detail.address;
        changed = true;
      }

      if (detail.country && !card.country) {
        card.country = detail.country;
        changed = true;
      }

      if (changed) enriched++;
    } catch (e) {
      // Log but continue
      if (i < 5) console.log(`   [directoryMiner] Error on detail ${i + 1}: ${e.message}`);
    }

    // Rate limiting
    if (i < toVisit.length - 1) {
      await page.waitForTimeout(delayMs);
    }
  }

  console.log(`   [directoryMiner] Enriched ${enriched}/${toVisit.length} cards from detail pages`);
}

// ─── Login Support ───────────────────────────────────────────────────

/**
 * Attempt login if config.login is provided.
 */
async function attemptLogin(page, loginConfig) {
  if (!loginConfig || !loginConfig.login_url) return false;

  console.log(`   [directoryMiner] Attempting login at: ${loginConfig.login_url}`);

  try {
    await page.goto(loginConfig.login_url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForLoadState("networkidle").catch(() => {});

    // Find and fill username/email field
    const userSelectors = [
      "input[name='email']", "input[name='username']", "input[name='user']",
      "input[type='email']", "input[name='login']", "input#email", "input#username"
    ];

    let filled = false;
    for (const sel of userSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.fill(loginConfig.username || loginConfig.email || "");
          filled = true;
          break;
        }
      } catch (e) {}
    }

    if (!filled) {
      console.log(`   [directoryMiner] Could not find username field, skipping login`);
      return false;
    }

    // Find and fill password field
    const passEl = await page.$("input[type='password']");
    if (passEl && loginConfig.password) {
      await passEl.fill(loginConfig.password);
    }

    // Submit
    const submitSelectors = [
      "button[type='submit']", "input[type='submit']",
      "button:has-text('Login')", "button:has-text('Sign in')",
      "button:has-text('Log in')"
    ];

    let submitted = false;
    for (const sel of submitSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          submitted = true;
          break;
        }
      } catch (e) {}
    }

    if (!submitted) {
      // Try pressing Enter
      await page.keyboard.press("Enter");
    }

    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2000);

    console.log(`   [directoryMiner] Login attempt completed`);
    return true;
  } catch (e) {
    console.log(`   [directoryMiner] Login failed: ${e.message}, continuing without login`);
    return false;
  }
}

// ─── Main Entry Point ────────────────────────────────────────────────

/**
 * Run the directory miner.
 *
 * @param {Page} page - Playwright page instance (browser already launched)
 * @param {string} url - Directory list page URL
 * @param {Object} config - Configuration options
 * @returns {Array} Raw card data (not normalized — flowOrchestrator handles normalization)
 */
async function runDirectoryMiner(page, url, config = {}) {
  const siteDomain = config.site_domain || getSiteDomain(url);
  config.site_domain = siteDomain;

  console.log(`\n[directoryMiner] Starting: ${url}`);
  console.log(`   [directoryMiner] Site domain: ${siteDomain}`);

  // Optional login
  if (config.login) {
    await attemptLogin(page, config.login);
  }

  // Phase 1: Crawl list pages
  const cards = await crawlListPages(page, url, config);
  console.log(`\n   [directoryMiner] Phase 1 complete: ${cards.length} business cards found`);

  // Phase 2: Visit detail pages (unless skip_details)
  if (!config.skip_details && cards.length > 0) {
    await enrichWithDetailPages(page, cards, config);
  } else if (config.skip_details) {
    console.log(`   [directoryMiner] Phase 2 skipped (skip_details=true)`);
  }

  // Coverage summary
  const total = cards.length;
  const withEmail = cards.filter(c => c.email || (c.all_emails && c.all_emails.length > 0)).length;
  const withPhone = cards.filter(c => c.phone).length;
  const withWebsite = cards.filter(c => c.website).length;

  console.log(`\n   [directoryMiner] Coverage: ${total} total, ${withEmail} email, ${withPhone} phone, ${withWebsite} website`);

  // Return raw cards — normalization handled by flowOrchestrator.normalizeResult()
  return cards;
}

module.exports = { runDirectoryMiner, getSiteDomain };
