/**
 * AI Miner Generator — Phase 0 Foundation
 *
 * Self-evolving mining engine: when all existing miners fail for a URL,
 * this service generates site-specific extraction code via Claude API,
 * tests it, and stores it for reuse on the same domain.
 *
 * Phase 0 scope:
 *   - findGeneratedMiner()   — DB lookup by domain
 *   - sanitizeHtml()         — prompt injection defense
 *   - securityScan()         — generated code safety check
 *   - validateResults()      — output quality validation
 *   - saveMiner()            — persist with pending_approval status
 *   - approveMiner()         — admin activation
 *   - disableMiner()         — deactivation with reason
 *   - recordSuccess/Failure  — quality tracking + auto-disable
 *
 * Phase 1+ (Part 2):
 *   - generateMiner()        — Claude API call
 *   - runGeneratedMiner()    — execute stored code
 *   - executeInSandbox()     — sandboxed execution
 */

const db = require('../db');

class AIMinerGenerator {

  // ---------------------------------------------------------------------------
  // DB LOOKUP
  // ---------------------------------------------------------------------------

  /**
   * Find an active generated miner for the given URL.
   * Matches on domain_pattern, returns the highest quality_score match.
   * @param {string} url - Target URL
   * @param {string|null} organizerId - Organizer scope (null = global only)
   * @returns {Object|null} generated_miners row or null
   */
  async findGeneratedMiner(url, organizerId = null) {
    let domain;
    try {
      domain = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      console.warn(`[AIMinerGenerator] Invalid URL for lookup: ${url}`);
      return null;
    }

    console.log(`[AIMinerGenerator] Looking up generated miner for domain=${domain}, organizer=${organizerId || 'global'}`);

    const { rows } = await db.query(
      `SELECT * FROM generated_miners
       WHERE domain_pattern = $1
         AND status = 'active'
         AND (organizer_id = $2 OR organizer_id IS NULL)
       ORDER BY
         CASE WHEN organizer_id = $2 THEN 0 ELSE 1 END,
         quality_score DESC NULLS LAST
       LIMIT 1`,
      [domain, organizerId]
    );

    if (rows.length === 0) {
      console.log(`[AIMinerGenerator] No active generated miner found for ${domain}`);
      return null;
    }

    console.log(`[AIMinerGenerator] Found generated miner id=${rows[0].id} v${rows[0].miner_version} (quality=${rows[0].quality_score})`);
    return rows[0];
  }

  // ---------------------------------------------------------------------------
  // HTML SANITIZATION — SECURITY CRITICAL
  // ---------------------------------------------------------------------------

  /**
   * Sanitize raw HTML before sending to LLM.
   * Removes injection vectors, invisible content, and unnecessary bloat.
   * @param {string} rawHtml - Raw HTML from target page
   * @returns {string} Sanitized HTML safe for LLM prompt
   */
  sanitizeHtml(rawHtml) {
    if (!rawHtml || typeof rawHtml !== 'string') return '';

    let html = rawHtml;

    // 1. HTML comments (injection vector)
    html = html.replace(/<!--[\s\S]*?-->/g, '');

    // 2. Script blocks
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '');

    // 3. Style blocks
    html = html.replace(/<style[\s\S]*?<\/style>/gi, '');

    // 4. Hidden elements (display:none, visibility:hidden, font-size:0)
    html = html.replace(/<[^>]+style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi, '');
    html = html.replace(/<[^>]+style\s*=\s*["'][^"']*visibility\s*:\s*hidden[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi, '');
    html = html.replace(/<[^>]+style\s*=\s*["'][^"']*font-size\s*:\s*0[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi, '');

    // 5. noscript content
    html = html.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

    // 6. Meta tags
    html = html.replace(/<meta[^>]*>/gi, '');

    // 7. Invisible Unicode characters (zero-width spaces etc.)
    html = html.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, '');

    // 8. Data URIs (base64 embedded content — wasteful tokens)
    html = html.replace(/data:[^"'\s]+/gi, 'data:removed');

    // 9. SVG content (large, unnecessary for extraction)
    html = html.replace(/<svg[\s\S]*?<\/svg>/gi, '');

    // 10. Truncate — max 50KB (~12K tokens)
    if (html.length > 50000) {
      html = html.substring(0, 50000) + '\n<!-- TRUNCATED -->';
    }

    console.log(`[AIMinerGenerator] HTML sanitized: ${rawHtml.length} → ${html.length} chars (${Math.round((1 - html.length / rawHtml.length) * 100)}% reduction)`);

    return html;
  }

  // ---------------------------------------------------------------------------
  // SECURITY SCANNER
  // ---------------------------------------------------------------------------

  /**
   * Scan AI-generated JavaScript code for dangerous patterns BEFORE execution.
   * @param {string} code - Generated JavaScript code
   * @returns {{ safe: boolean, violations: Array<{ pattern: string, reason: string }> }}
   */
  securityScan(code) {
    if (!code || typeof code !== 'string') {
      return { safe: false, violations: [{ pattern: 'N/A', reason: 'empty or non-string code' }] };
    }

    const forbidden = [
      { pattern: /require\s*\(/, reason: 'Node.js require() — sandbox escape' },
      { pattern: /import\s+/, reason: 'ES import — sandbox escape' },
      { pattern: /process\./, reason: 'process access — env vars, exit' },
      { pattern: /global\./, reason: 'global object access' },
      { pattern: /globalThis\./, reason: 'globalThis access' },
      { pattern: /eval\s*\(/, reason: 'nested eval — code injection' },
      { pattern: /Function\s*\(/, reason: 'Function constructor — code injection' },
      { pattern: /fetch\s*\(/, reason: 'network request — data exfiltration' },
      { pattern: /XMLHttpRequest/, reason: 'XHR — data exfiltration' },
      { pattern: /\.cookie/, reason: 'cookie access' },
      { pattern: /localStorage/, reason: 'localStorage access' },
      { pattern: /sessionStorage/, reason: 'sessionStorage access' },
      { pattern: /indexedDB/, reason: 'IndexedDB access' },
      { pattern: /navigator\.sendBeacon/, reason: 'beacon — data exfiltration' },
      { pattern: /WebSocket/, reason: 'WebSocket — data exfiltration' },
      { pattern: /new\s+Worker/, reason: 'Web Worker — sandbox escape' },
      { pattern: /window\.open/, reason: 'popup window' },
      { pattern: /document\.write/, reason: 'document.write — DOM manipulation' },
      { pattern: /\.innerHTML\s*=/, reason: 'innerHTML assignment — XSS risk' },
      { pattern: /\.outerHTML\s*=/, reason: 'outerHTML assignment — XSS risk' },
    ];

    const violations = [];
    for (const { pattern, reason } of forbidden) {
      if (pattern.test(code)) {
        violations.push({ pattern: pattern.toString(), reason });
      }
    }

    if (violations.length > 0) {
      console.warn(`[AIMinerGenerator] Security scan FAILED: ${violations.length} violation(s)`);
      violations.forEach(v => console.warn(`  - ${v.reason}: ${v.pattern}`));
      return { safe: false, violations };
    }

    console.log('[AIMinerGenerator] Security scan passed');
    return { safe: true, violations: [] };
  }

  // ---------------------------------------------------------------------------
  // OUTPUT VALIDATION
  // ---------------------------------------------------------------------------

  /**
   * Validate extraction results from a generated miner.
   * Checks email presence, format, duplicates, and hallucination signals.
   * @param {Array} results - Extraction results array
   * @returns {{ valid: boolean, reason: string|null, stats: Object|null }}
   */
  validateResults(results) {
    // Type check
    if (!Array.isArray(results)) {
      return { valid: false, reason: 'not_array', stats: null };
    }

    if (results.length === 0) {
      return { valid: false, reason: 'empty_results', stats: null };
    }

    // Email presence — at least 30% must have an email
    const withEmail = results.filter(r => r.email && typeof r.email === 'string' && r.email.includes('@'));
    const emailRate = withEmail.length / results.length;
    if (emailRate < 0.3) {
      return { valid: false, reason: `low_email_rate: ${(emailRate * 100).toFixed(1)}%`, stats: { emailRate } };
    }

    // Email format — 80%+ of emails must be valid format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const validEmails = withEmail.filter(r => emailRegex.test(r.email));
    const formatRate = validEmails.length / withEmail.length;
    if (formatRate < 0.8) {
      return { valid: false, reason: `invalid_email_format: ${(formatRate * 100).toFixed(1)}%`, stats: { emailRate, formatRate } };
    }

    // Duplicate check — >50% duplicate is suspicious
    const uniqueEmails = new Set(withEmail.map(r => r.email.toLowerCase()));
    const uniqueRate = uniqueEmails.size / withEmail.length;
    if (uniqueRate < 0.5) {
      return { valid: false, reason: `too_many_duplicates: ${(uniqueRate * 100).toFixed(1)}% unique`, stats: { emailRate, formatRate, uniqueRate } };
    }

    // Hallucination check — single domain with 5+ emails is suspicious
    const domains = new Set(withEmail.map(r => r.email.split('@')[1]));
    if (domains.size === 1 && withEmail.length > 5) {
      return { valid: false, reason: 'single_domain_suspicious', stats: { emailRate, formatRate, uniqueRate, domainCount: domains.size } };
    }

    // Field presence (informational, not blocking)
    const withCompany = results.filter(r => r.company_name && r.company_name.trim().length > 0);
    const withPhone = results.filter(r => r.phone && r.phone.trim().length > 0);

    const stats = {
      totalResults: results.length,
      withEmail: withEmail.length,
      emailRate: Math.round(emailRate * 100),
      withCompany: withCompany.length,
      companyRate: Math.round((withCompany.length / results.length) * 100),
      withPhone: withPhone.length,
      phoneRate: Math.round((withPhone.length / results.length) * 100),
      uniqueEmails: uniqueEmails.size,
      uniqueDomains: domains.size,
      formatRate: Math.round(formatRate * 100),
      uniqueRate: Math.round(uniqueRate * 100),
    };

    console.log(`[AIMinerGenerator] Validation passed — ${stats.totalResults} results, ${stats.emailRate}% email, ${stats.companyRate}% company, ${stats.phoneRate}% phone`);

    return { valid: true, reason: null, stats };
  }

  // ---------------------------------------------------------------------------
  // DB PERSISTENCE
  // ---------------------------------------------------------------------------

  /**
   * Save a generated miner to DB with pending_approval status.
   * @param {Object} params
   * @param {string} params.url - Source URL
   * @param {string} params.domainPattern - Extracted domain
   * @param {string} params.code - Generated JavaScript code
   * @param {string|null} params.organizerId - Organizer scope
   * @param {string} params.model - AI model used
   * @param {string} params.promptVersion - Prompt version
   * @param {number} params.tokensUsed - Tokens consumed
   * @param {Object} params.testResult - Test run result
   * @param {string} params.htmlHash - SHA-256 of source HTML
   * @returns {Object} Saved generated_miners row
   */
  async saveMiner({ url, domainPattern, code, organizerId = null, model, promptVersion, tokensUsed, testResult, htmlHash }) {
    console.log(`[AIMinerGenerator] Saving generated miner for domain=${domainPattern}, organizer=${organizerId || 'global'}`);

    const { rows } = await db.query(
      `INSERT INTO generated_miners
         (organizer_id, domain_pattern, miner_code, source_url, source_html_hash,
          ai_model, ai_prompt_version, generation_tokens_used, test_result, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_approval')
       RETURNING *`,
      [organizerId, domainPattern, code, url, htmlHash, model, promptVersion, tokensUsed, JSON.stringify(testResult)]
    );

    console.log(`[AIMinerGenerator] Saved miner id=${rows[0].id} status=pending_approval`);
    return rows[0];
  }

  /**
   * Approve a generated miner (admin action). Sets status to 'active'.
   * @param {string} minerId - generated_miners.id
   * @param {string} userId - Approving user ID
   * @returns {Object} Updated row
   */
  async approveMiner(minerId, userId) {
    console.log(`[AIMinerGenerator] Approving miner id=${minerId} by user=${userId}`);

    const { rows } = await db.query(
      `UPDATE generated_miners
       SET status = 'active', approved_by = $2, approved_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [minerId, userId]
    );

    if (rows.length === 0) {
      console.warn(`[AIMinerGenerator] Miner ${minerId} not found for approval`);
      return null;
    }

    console.log(`[AIMinerGenerator] Miner ${minerId} approved — now active`);
    return rows[0];
  }

  /**
   * Disable a generated miner with a reason.
   * @param {string} minerId
   * @param {string} reason
   * @returns {Object} Updated row
   */
  async disableMiner(minerId, reason) {
    console.log(`[AIMinerGenerator] Disabling miner id=${minerId}, reason=${reason}`);

    const { rows } = await db.query(
      `UPDATE generated_miners
       SET status = 'disabled', disabled_reason = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [minerId, reason]
    );

    if (rows.length === 0) {
      console.warn(`[AIMinerGenerator] Miner ${minerId} not found for disable`);
      return null;
    }

    console.log(`[AIMinerGenerator] Miner ${minerId} disabled`);
    return rows[0];
  }

  // ---------------------------------------------------------------------------
  // QUALITY TRACKING
  // ---------------------------------------------------------------------------

  /**
   * Record a successful miner execution.
   * @param {string} minerId
   * @param {number} contactCount - Number of contacts extracted
   * @returns {Object} Updated row
   */
  async recordSuccess(minerId, contactCount) {
    const { rows } = await db.query(
      `UPDATE generated_miners
       SET success_count = success_count + 1,
           total_contacts_mined = total_contacts_mined + $2,
           last_used_at = NOW(),
           last_success_at = NOW(),
           quality_score = ROUND(((success_count + 1)::numeric / (success_count + 1 + failure_count)), 2),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [minerId, contactCount]
    );

    if (rows.length > 0) {
      console.log(`[AIMinerGenerator] Recorded success for miner ${minerId}: +${contactCount} contacts (total=${rows[0].total_contacts_mined}, quality=${rows[0].quality_score})`);
    }

    return rows[0] || null;
  }

  /**
   * Record a failed miner execution.
   * Auto-disables after 3+ consecutive failures (quality_score drops below threshold).
   * @param {string} minerId
   * @returns {Object} Updated row
   */
  async recordFailure(minerId) {
    const { rows } = await db.query(
      `UPDATE generated_miners
       SET failure_count = failure_count + 1,
           last_used_at = NOW(),
           quality_score = ROUND((success_count::numeric / (success_count + failure_count + 1)), 2),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [minerId]
    );

    if (rows.length === 0) return null;

    const miner = rows[0];
    console.log(`[AIMinerGenerator] Recorded failure for miner ${minerId} (quality=${miner.quality_score}, failures=${miner.failure_count})`);

    // Auto-disable: 3+ failures AND quality below 0.3
    if (miner.failure_count >= 3 && parseFloat(miner.quality_score) < 0.3) {
      console.warn(`[AIMinerGenerator] Auto-disabling miner ${minerId} — quality ${miner.quality_score} below threshold after ${miner.failure_count} failures`);
      return this.disableMiner(minerId, `auto-disabled: quality=${miner.quality_score} after ${miner.failure_count} failures`);
    }

    return miner;
  }

  /**
   * Calculate quality score from success/failure counts.
   * @param {number} successCount
   * @param {number} failureCount
   * @returns {number} 0-1 score
   */
  calculateQualityScore(successCount, failureCount) {
    const total = successCount + failureCount;
    if (total === 0) return 0.5; // New miner — neutral
    return Math.round((successCount / total) * 100) / 100;
  }

  // ---------------------------------------------------------------------------
  // PHASE 1+ PLACEHOLDERS (Part 2)
  // ---------------------------------------------------------------------------

  // async generateMiner(url, html, screenshot) {}
  // async runGeneratedMiner(minerRecord, page, url) {}
  // async executeInSandbox(code, page, url) {}
}

module.exports = new AIMinerGenerator();
