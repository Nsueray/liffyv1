/**
 * Shared Playwright browser configuration + Cloudflare handling.
 * All miners should use these helpers instead of inline browser config.
 *
 * Features:
 * - User-agent rotation (6 real Chrome/Firefox UAs)
 * - Stealth: webdriver flag hidden, headless detection bypass
 * - Cloudflare wait & retry (JS challenge auto-solve)
 * - Improved block detection (Turnstile/CAPTCHA → needs_manual)
 */

// ─── User-Agent Pool ────────────────────────────────────────────────

const USER_AGENTS = [
  // Chrome 122 macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  // Chrome 122 Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  // Chrome 121 macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  // Firefox 123 Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  // Firefox 123 macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:123.0) Gecko/20100101 Firefox/123.0',
  // Chrome 122 Linux
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

/**
 * Get a random user-agent from the pool.
 */
function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ─── Stealth Launch Args ────────────────────────────────────────────

/**
 * Chromium launch args that reduce headless detection fingerprinting.
 */
const STEALTH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',  // hides webdriver flag
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-infobars',
];

/**
 * Get standard browser launch options.
 */
function getLaunchOptions() {
  return {
    headless: true,
    args: STEALTH_ARGS,
  };
}

/**
 * Get standard browser context options.
 * Rotates user-agent per context.
 */
function getContextOptions(overrides = {}) {
  return {
    userAgent: getRandomUserAgent(),
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
    // Spoof navigator properties to reduce bot detection
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
    ...overrides,
  };
}

/**
 * Apply stealth scripts to a page (call after page creation).
 * Hides navigator.webdriver and patches common bot-detection signals.
 */
async function applyStealthScripts(page) {
  await page.addInitScript(() => {
    // Hide webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // Fake plugins array (headless Chrome has 0 plugins)
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' },
      ],
    });

    // Fake languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });

    // Remove headless Chrome indicators from window.chrome
    if (!window.chrome) {
      window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
    }

    // Fake permissions query
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    }
  });
}

// ─── Cloudflare Detection & Handling ────────────────────────────────

/**
 * Cloudflare challenge page patterns.
 * Grouped by severity:
 * - JS_CHALLENGE: auto-solvable by waiting
 * - TURNSTILE/CAPTCHA: requires human interaction → needs_manual
 */
const CF_PATTERNS = {
  // JS challenge — solvable by waiting 5-8 seconds
  jsChallenge: [
    'just a moment',
    'checking your browser',
    'please wait',
    'ddos protection by cloudflare',
    'enable javascript and cookies',
    'cf-browser-verification',
    'performing a security check',
  ],
  // Turnstile/CAPTCHA — NOT auto-solvable
  hardChallenge: [
    'cf-turnstile',
    'turnstile-wrapper',
    'hcaptcha',
    'h-captcha',
    'g-recaptcha',
    'recaptcha',
    'verify you are human',
    'complete the security check',
  ],
  // Hard block — server refuses
  hardBlock: [
    'access denied',
    'forbidden',
    '403 forbidden',
    'you have been blocked',
    'sorry, you have been blocked',
    'ray id',
  ],
};

/**
 * Detect Cloudflare challenge type on a page.
 * @param {import('playwright').Page} page
 * @returns {Promise<'none'|'js_challenge'|'hard_challenge'|'hard_block'>}
 */
async function detectCloudflare(page) {
  const analysis = await page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    const html = (document.documentElement?.outerHTML || '').toLowerCase();
    const title = (document.title || '').toLowerCase();
    return { text, html, title };
  });

  const combined = analysis.text + ' ' + analysis.title + ' ' + analysis.html;

  // Check hard challenge first (most specific)
  for (const pattern of CF_PATTERNS.hardChallenge) {
    if (combined.includes(pattern)) return 'hard_challenge';
  }

  // Check hard block
  for (const pattern of CF_PATTERNS.hardBlock) {
    if (combined.includes(pattern)) return 'hard_block';
  }

  // Check JS challenge
  for (const pattern of CF_PATTERNS.jsChallenge) {
    if (combined.includes(pattern)) return 'js_challenge';
  }

  return 'none';
}

/**
 * Wait for Cloudflare JS challenge to resolve.
 * Waits up to maxWait ms, checking every interval.
 * Returns true if challenge resolved, false if still blocked.
 */
async function waitForCloudflareChallenge(page, { maxWait = 10000, interval = 2000 } = {}) {
  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < maxWait) {
    attempt++;
    await page.waitForTimeout(interval);

    const status = await detectCloudflare(page);

    if (status === 'none') {
      console.log(`  ✅ Cloudflare JS challenge resolved after ${attempt * interval / 1000}s`);
      return true;
    }

    if (status === 'hard_challenge' || status === 'hard_block') {
      console.log(`  🚫 Cloudflare ${status} — cannot auto-bypass`);
      return false;
    }

    console.log(`  ⏳ Cloudflare JS challenge still active (attempt ${attempt})...`);
  }

  console.log(`  ⏰ Cloudflare JS challenge did not resolve within ${maxWait / 1000}s`);
  return false;
}

/**
 * Navigate to URL with Cloudflare handling.
 * If JS challenge detected, waits for auto-resolution.
 * Returns: { success, cfStatus, response }
 *   cfStatus: 'none' | 'js_challenge_resolved' | 'hard_challenge' | 'hard_block' | 'js_challenge_timeout'
 */
async function navigateWithCfHandling(page, url, { timeout = 30000, waitUntil = 'domcontentloaded' } = {}) {
  let response;
  try {
    response = await page.goto(url, { timeout, waitUntil });
  } catch (err) {
    return { success: false, cfStatus: 'navigation_error', response: null, error: err.message };
  }

  // Check for Cloudflare
  const cfStatus = await detectCloudflare(page);

  if (cfStatus === 'none') {
    return { success: true, cfStatus: 'none', response };
  }

  if (cfStatus === 'hard_challenge') {
    console.log(`  🚫 Cloudflare Turnstile/CAPTCHA detected on ${url}`);
    return { success: false, cfStatus: 'hard_challenge', response };
  }

  if (cfStatus === 'hard_block') {
    console.log(`  🚫 Cloudflare hard block on ${url}`);
    return { success: false, cfStatus: 'hard_block', response };
  }

  // JS challenge — wait for auto-resolution
  console.log(`  ☁️ Cloudflare JS challenge detected on ${url} — waiting...`);
  const resolved = await waitForCloudflareChallenge(page);

  if (resolved) {
    return { success: true, cfStatus: 'js_challenge_resolved', response };
  }

  return { success: false, cfStatus: 'js_challenge_timeout', response };
}

// ─── Enhanced checkBlock (drop-in replacement) ──────────────────────

/**
 * Enhanced block detection. Drop-in replacement for miningWorker.checkBlock().
 * Returns { blocked: boolean, reason: string|null, cfStatus: string }
 */
async function checkBlock(page, response) {
  // 1. HTTP status
  if (response && [401, 403, 406, 429].includes(response.status())) {
    return { blocked: true, reason: `HTTP ${response.status()}`, cfStatus: 'http_block' };
  }

  // 2. Cloudflare-specific detection
  const cfStatus = await detectCloudflare(page);
  if (cfStatus !== 'none') {
    return { blocked: true, reason: `Cloudflare: ${cfStatus}`, cfStatus };
  }

  // 3. Generic content heuristics
  const stats = await page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    const title = (document.title || '').toLowerCase();
    return {
      text,
      title,
      anchors: document.querySelectorAll('a').length,
    };
  });

  const blockKeywords = ['forbidden', 'access denied', 'security check', 'captcha'];
  const foundKeyword = blockKeywords.find(kw => stats.text.includes(kw) || stats.title.includes(kw));
  if (foundKeyword) {
    return { blocked: true, reason: `Content: "${foundKeyword}"`, cfStatus: 'content_block' };
  }

  // 4. Low anchor count heuristic (soft block / empty render)
  if (stats.anchors < 3) {
    return { blocked: true, reason: `Low anchors (${stats.anchors})`, cfStatus: 'empty_render' };
  }

  return { blocked: false, reason: null, cfStatus: 'none' };
}

// ─── Exports ────────────────────────────────────────────────────────

module.exports = {
  // User-agent
  USER_AGENTS,
  getRandomUserAgent,

  // Browser config
  STEALTH_ARGS,
  getLaunchOptions,
  getContextOptions,
  applyStealthScripts,

  // Cloudflare
  CF_PATTERNS,
  detectCloudflare,
  waitForCloudflareChallenge,
  navigateWithCfHandling,
  checkBlock,
};
