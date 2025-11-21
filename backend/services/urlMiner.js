const axios = require('axios');
const cheerio = require('cheerio');
const db = require('../db');

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const EXHIBITOR_HINT_REGEX = /(exhibitor|exhibitors|company|profile|stand)/i;
const MAX_DETAIL_PAGES = 40;

/**
 * Normalize and deduplicate emails
 */
function extractUniqueEmails(text) {
  if (!text) return [];
  const matches = text.match(EMAIL_REGEX) || [];
  const normalized = matches
    .map(e => e.trim().toLowerCase())
    .filter(e => !e.startsWith('mailto:'));
  return Array.from(new Set(normalized));
}

/**
 * Try to guess company name from HTML
 */
function guessCompanyName($) {
  const title = $('title').first().text().trim();
  if (title) return title;

  const metaDesc = $('meta[name="description"]').attr('content');
  if (metaDesc) return metaDesc.trim();

  const h1 = $('h1').first().text().trim();
  if (h1) return h1;

  const h2 = $('h2').first().text().trim();
  if (h2) return h2;

  return null;
}

/**
 * Extract company-ish anchor texts
 */
function extractPotentialCompanies($) {
  const companies = [];
  $('a').each((_, el) => {
    const text = $(el).text().trim();
    if (!text) return;
    if (text.length < 3 || text.length > 100) return;
    if (/(click here|read more|home|privacy|about us|contact us|http|www\.)/i.test(text)) return;
    companies.push(text);
  });
  return Array.from(new Set(companies));
}

/**
 * Find exhibitor detail URLs on the root page.
 * Heuristics:
 *  - Same hostname as root URL
 *  - href or anchor text matches exhibitor/company/profile/stand
 */
function extractDetailUrls($, rootUrl) {
  const detailUrls = new Set();
  let rootHostname;

  try {
    rootHostname = new URL(rootUrl).hostname;
  } catch {
    return [];
  }

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;

    let full;
    try {
      full = new URL(href, rootUrl).href;
    } catch {
      return;
    }

    let u;
    try {
      u = new URL(full);
    } catch {
      return;
    }

    if (u.hostname !== rootHostname) return;

    const anchorText = $(el).text().trim();
    const haystack = `${href} ${anchorText}`.toLowerCase();

    if (EXHIBITOR_HINT_REGEX.test(haystack)) {
      detailUrls.add(full);
    }
  });

  return Array.from(detailUrls).slice(0, MAX_DETAIL_PAGES);
}

/**
 * Run URL mining job:
 *  - Mark job running
 *  - Fetch root HTML
 *  - Extract emails from root
 *  - Extract exhibitor-like detail URLs
 *  - For each detail URL, fetch and extract emails
 *  - Insert prospects
 *  - Create a list and attach members
 *  - Mark job completed / failed
 */
async function runUrlMiningJob(jobId, organizerId) {
  const client = await db.connect();

  try {
    // Load job
    const jobRes = await client.query(
      `SELECT * FROM mining_jobs WHERE id = $1 AND organizer_id = $2`,
      [jobId, organizerId]
    );
    if (jobRes.rows.length === 0) {
      throw new Error('Mining job not found');
    }
    const job = jobRes.rows[0];

    if (job.type !== 'url') {
      throw new Error(`Mining job type must be 'url', got '${job.type}'`);
    }

    // Mark job as running
    await client.query(
      `UPDATE mining_jobs
       SET status = 'running', started_at = NOW(), error = NULL
       WHERE id = $1`,
      [jobId]
    );

    const rootUrl = job.input;
    let rootHtml;

    // Fetch root HTML
    try {
      const resp = await axios.get(rootUrl, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; LiffyBot/1.0; +https://liffy.app)'
        }
      });
      rootHtml = resp.data;
    } catch (err) {
      throw new Error(`Failed to fetch URL: ${err.message}`);
    }

    const $root = cheerio.load(rootHtml);
    const rootText = $root.text();

    const emailsFromRootText = extractUniqueEmails(rootText);
    const hrefEmails = [];
    $root('a[href]').each((_, el) => {
      const href = $root(el).attr('href');
      if (!href) return;
      const found = extractUniqueEmails(href);
      hrefEmails.push(...found);
    });

    const allEmailsSet = new Set([
      ...emailsFromRootText,
      ...hrefEmails
    ]);

    const companyGuess = guessCompanyName($root);
    const extraCompanies = extractPotentialCompanies($root);
    const detailUrls = extractDetailUrls($root, rootUrl);

    // Crawl exhibitor detail pages
    const detailEmails = new Set();

    for (const detailUrl of detailUrls) {
      try {
        const resp = await axios.get(detailUrl, {
          timeout: 12000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; LiffyBot/1.0; +https://liffy.app)'
          }
        });
        const html = resp.data;
        const $d = cheerio.load(html);
        const text = $d.text();

        const emailsFromText = extractUniqueEmails(text);
        emailsFromText.forEach(e => detailEmails.add(e));

        $d('a[href]').each((_, el) => {
          const href = $d(el).attr('href');
          if (!href) return;
          const found = extractUniqueEmails(href);
          found.forEach(e => detailEmails.add(e));
        });

      } catch (err) {
        console.error(`Detail URL fetch error (${detailUrl}):`, err.message);
        continue;
      }
    }

    // Merge detail emails
    detailEmails.forEach(e => allEmailsSet.add(e));
    const allEmails = Array.from(allEmailsSet);

    const stats = {
      url: rootUrl,
      emails_raw: allEmails.length,
      emails_from_root: emailsFromRootText.length,
      emails_from_details: detailEmails.size,
      detail_urls_considered: detailUrls.length,
      company_guess: companyGuess,
      extra_companies: extraCompanies.slice(0, 100)
    };

    // Insert prospects
    let prospectsCreated = 0;
    const prospectIds = [];

    for (const email of allEmails) {
      const existing = await client.query(
        `SELECT id FROM prospects
         WHERE organizer_id = $1 AND email = $2`,
        [organizerId, email]
      );

      if (existing.rows.length > 0) {
        prospectIds.push(existing.rows[0].id);
        continue;
      }

      const insertRes = await client.query(
        `INSERT INTO prospects
         (organizer_id, email, company, country, sector, source_type, source_ref, verification_status, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [
          organizerId,
          email,
          companyGuess || null,
          null,
          null,
          'url',
          rootUrl,
          'unknown',
          { extra_companies: extraCompanies.slice(0, 100) }
        ]
      );

      prospectsCreated += 1;
      prospectIds.push(insertRes.rows[0].id);
    }

    // Create list if any prospects
    let listId = null;
    if (prospectIds.length > 0) {
      const hostname = (() => {
        try {
          return new URL(rootUrl).hostname;
        } catch {
          return 'unknown-host';
        }
      })();

      const listName = `URL Mining – ${hostname} – ${jobId.slice(0, 8)}`;

      const listRes = await client.query(
        `INSERT INTO lists
         (organizer_id, name, description, type)
         VALUES ($1,$2,$3,$4)
         RETURNING id`,
        [
          organizerId,
          listName,
          `Auto-created from URL mining job ${jobId}`,
          'mined'
        ]
      );

      listId = listRes.rows[0].id;

      const values = [];
      const placeholders = [];

      prospectIds.forEach((pid, i) => {
        const idx = i * 3;
        values.push(organizerId, listId, pid);
        placeholders.push(`($${idx+1}, $${idx+2}, $${idx+3})`);
      });

      await client.query(
        `INSERT INTO list_members (organizer_id, list_id, prospect_id)
         VALUES ${placeholders.join(",")}
         ON CONFLICT DO NOTHING`,
        values
      );
    }

    await client.query(
      `UPDATE mining_jobs
       SET status = 'completed',
           total_found = $2,
           total_prospects_created = $3,
           total_emails_raw = $4,
           stats = $5,
           completed_at = NOW()
       WHERE id = $1`,
      [
        jobId,
        allEmails.length,
        prospectsCreated,
        allEmails.length,
        stats
      ]
    );

    return {
      success: true,
      job_id: jobId,
      total_emails_raw: allEmails.length,
      total_prospects_created: prospectsCreated,
      list_id: listId,
      stats
    };

  } catch (err) {
    console.error("runUrlMiningJob error:", err.message);
    await db.query(
      `UPDATE mining_jobs
       SET status = 'failed',
           error = $2,
           completed_at = NOW()
       WHERE id = $1`,
      [jobId, err.message]
    );

    return {
      success: false,
      job_id: jobId,
      error: err.message
    };
  } finally {
    client.release();
  }
}

module.exports = {
  runUrlMiningJob
};
