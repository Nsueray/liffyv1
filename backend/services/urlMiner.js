const axios = require('axios');
const cheerio = require('cheerio');
const db = require('../db');

/**
 * Simple email regex (case-insensitive)
 */
const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

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
 * Try to guess company name from HTML:
 * - <title>
 * - <meta name="description">
 * - First <h1> or <h2>
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
 * Extract additional context from links: anchor text that looks like company names.
 * This is v2 and intentionally simple.
 */
function extractPotentialCompanies($) {
  const companies = [];
  $('a').each((_, el) => {
    const text = $(el).text().trim();
    if (text && text.length > 3 && text.length < 100) {
      // Heuristic: exclude obvious junk
      if (!text.match(/(click here|read more|http|www\.)/i)) {
        companies.push(text);
      }
    }
  });
  return Array.from(new Set(companies));
}

/**
 * Run URL mining job:
 * - Mark job as running
 * - Fetch HTML
 * - Extract emails + company hints
 * - Insert prospects
 * - Create a list and attach members
 * - Mark job as completed or failed
 *
 * Returns: stats object
 */
async function runUrlMiningJob(jobId, organizerId) {
  const client = await db.connect();

  try {
    // 1) Load job
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

    // 2) Mark job as running
    await client.query(
      `UPDATE mining_jobs
       SET status = 'running', started_at = NOW(), error = NULL
       WHERE id = $1`,
      [jobId]
    );

    const url = job.input;

    // 3) Fetch HTML
    let html;
    try {
      const resp = await axios.get(url, {
        timeout: 12000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; LiffyBot/1.0; +https://liffy.app)'
        }
      });
      html = resp.data;
    } catch (err) {
      throw new Error(`Failed to fetch URL: ${err.message}`);
    }

    const $ = cheerio.load(html);

    // 4) Extract emails from full HTML
    const allText = $.text();
    const emailsFromText = extractUniqueEmails(allText);

    // Also scan 'href' attributes (mailto and plain)
    const hrefEmails = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const found = extractUniqueEmails(href);
      hrefEmails.push(...found);
    });

    const allEmails = Array.from(new Set([...emailsFromText, ...hrefEmails]));

    // 5) Company guess
    const companyGuess = guessCompanyName($);
    const extraCompanies = extractPotentialCompanies($);

    const stats = {
      url,
      emails_raw: allEmails.length,
      company_guess: companyGuess,
      extra_companies: extraCompanies.slice(0, 50) // limit to 50
    };

    // 6) Insert prospects
    let prospectsCreated = 0;
    const prospectIds = [];

    for (const email of allEmails) {
      // Check if prospect already exists for this organizer + email
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
          null,               // country unknown at this stage
          null,               // sector unknown at this stage
          'url',
          url,
          'unknown',
          { extra_companies: extraCompanies.slice(0, 50) }
        ]
      );

      prospectsCreated += 1;
      prospectIds.push(insertRes.rows[0].id);
    }

    // 7) Create a list for this job and attach all prospects
    let listId = null;
    if (prospectIds.length > 0) {
      const listName = `URL Mining – ${new URL(url).hostname} – ${jobId.slice(0, 8)}`;

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

    // 8) Update job as completed
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
