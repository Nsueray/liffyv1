/**
 * GenericExtractor — Config-driven data extraction using Playwright semantic locators.
 * AI ürettiği JSON config'i alır, sabit template ile çalıştırır.
 * Kod hiç değişmez — sadece config değişir.
 *
 * v2 Architecture: Claude produces JSON config, this template executes it.
 * No AI-generated code runs — only pre-built extraction logic driven by config.
 */

class GenericExtractor {

  /**
   * Listing sayfasından entity'leri çıkar.
   * @param {Page} page - Playwright Page (already navigated)
   * @param {Object} config - Claude'un ürettiği listing config
   * @returns {{ entities: Array, debugInfo: Object }}
   */
  async extractListing(page, config) {
    const debugInfo = { selectorsFound: {}, errors: [], mode: 'container' };
    const entities = [];

    try {
      // Detect extraction mode: anchor-based vs container-based
      const isAnchorMode = config.entity_mode === 'anchor' || this.isHeadingRole(config.entity_role);

      if (isAnchorMode) {
        // ============================
        // ANCHOR-BASED EXTRACTION
        // Entities are NOT wrapped in a container — they're flat siblings
        // anchored by repeating headings at the same level.
        // Example: heading[5] "Company A" → siblings → heading[5] "Company B" → siblings
        // ============================
        debugInfo.mode = 'anchor';
        const roleOpts = this.parseRoleOptions(config.entity_role);
        const roleName = config.entity_role.split('[')[0].split(' ')[0].trim();

        console.log(`[GenericExtractor] Anchor-based mode: role=${roleName}, opts=${JSON.stringify(roleOpts)}`);

        // Use page.evaluate to group anchor headings + their sibling data
        const rawEntities = await page.evaluate(({ roleName: rn, level }) => {
          // Find all headings at the target level
          const selector = level ? `h${level}` : `h1, h2, h3, h4, h5, h6`;
          const headings = Array.from(document.querySelectorAll(selector));
          if (headings.length === 0) return [];

          const results = [];

          for (let i = 0; i < headings.length; i++) {
            const heading = headings[i];
            const companyName = heading.textContent.trim();
            if (!companyName) continue;

            // Collect sibling elements until the next heading at same level
            const siblings = [];
            let sibling = heading.nextElementSibling;
            const nextHeading = headings[i + 1] || null;

            while (sibling && sibling !== nextHeading) {
              siblings.push({
                tag: sibling.tagName.toLowerCase(),
                text: sibling.textContent.trim(),
                html: sibling.innerHTML,
                links: Array.from(sibling.querySelectorAll('a')).map(a => ({
                  href: a.href,
                  text: a.textContent.trim()
                }))
              });
              sibling = sibling.nextElementSibling;
            }

            // Extract fields from siblings
            let email = null;
            let phone = null;
            let website = null;
            let detailUrl = null;
            let country = null;
            let address = null;

            for (const sib of siblings) {
              // Email: mailto link
              for (const link of sib.links) {
                if (link.href && link.href.startsWith('mailto:')) {
                  email = link.href.replace('mailto:', '').split('?')[0].trim();
                }
                if (link.href && link.href.startsWith('tel:')) {
                  phone = link.href.replace('tel:', '').trim();
                }
              }
              // Email: text with @
              if (!email) {
                const emailMatch = sib.text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
                if (emailMatch) email = emailMatch[0];
              }
              // Phone: text with phone pattern (not already found via tel:)
              if (!phone) {
                const phoneMatch = sib.text.match(/[\+]?[\d\s\-\(\)]{7,}/);
                if (phoneMatch && !sib.text.includes('@')) phone = phoneMatch[0].trim();
              }
              // Detail link: non-mailto, non-tel link on same domain
              if (!detailUrl) {
                for (const link of sib.links) {
                  if (link.href && !link.href.startsWith('mailto:') && !link.href.startsWith('tel:')
                      && link.href.startsWith('http')) {
                    detailUrl = link.href;
                  }
                }
              }
            }

            results.push({
              company_name: companyName,
              email,
              phone,
              website,
              detail_url: detailUrl,
              country,
              address
            });
          }

          return results;
        }, { roleName, level: roleOpts.level || null });

        debugInfo.selectorsFound.anchor_headings = rawEntities.length;
        console.log(`[GenericExtractor] Anchor mode found ${rawEntities.length} entities`);

        for (const entity of rawEntities) {
          if (entity.company_name && entity.company_name.trim()) {
            entities.push(entity);
          }
        }

      } else {
        // ============================
        // CONTAINER-BASED EXTRACTION (original mode)
        // Entities are wrapped in container elements (listitem, article, card div)
        // ============================
        debugInfo.mode = 'container';
        let entityLocators;

        if (config.entity_role) {
          // Semantic: getByRole
          try {
            entityLocators = await page.getByRole(config.entity_role).all();
            debugInfo.selectorsFound.entity_role = entityLocators.length;
          } catch (roleErr) {
            debugInfo.errors.push(`getByRole('${config.entity_role}') failed: ${roleErr.message}`);
          }
        }

        if ((!entityLocators || entityLocators.length === 0) && config.entity_selector) {
          // CSS fallback
          try {
            entityLocators = await page.locator(config.entity_selector).all();
            debugInfo.selectorsFound.entity_selector = entityLocators.length;
          } catch (selErr) {
            debugInfo.errors.push(`locator('${config.entity_selector}') failed: ${selErr.message}`);
          }
        }

        if (!entityLocators || entityLocators.length === 0) {
          debugInfo.errors.push(`No entities found with role="${config.entity_role}" or selector="${config.entity_selector}"`);
          return { entities: [], debugInfo };
        }

        // ============================
        // FAST PATH: entity_role === 'link' → bulk page.evaluate()
        // 14 entity × 6 locator calls × 2-5s = 3-7 min → page.evaluate = 100ms
        // ============================
        if (config.entity_role === 'link') {
          console.log(`[GenericExtractor] entity_role=link — using FAST bulk page.evaluate() path`);
          const bulkResults = await this.bulkExtractFromPage(page, config);
          debugInfo.selectorsFound.bulk_extracted = bulkResults.length;
          console.log(`[GenericExtractor] Bulk extracted ${bulkResults.length} link entities`);

          // Filter through isValidDetailUrl + isNavigationLink + isBusinessProfileLink
          const baseUrl = page.url();
          for (const item of bulkResults) {
            if (!item.company_name || !item.company_name.trim()) continue;
            if (item.detail_url && !this.isValidDetailUrl(item.detail_url, baseUrl)) {
              item.detail_url = null;
            }
            item.company_name = item.company_name.trim();
            entities.push(item);
          }
          debugInfo.selectorsFound.after_filter = entities.length;
          console.log(`[GenericExtractor] After filtering: ${entities.length} valid link entities`);

        } else {
        // ============================
        // STANDARD PATH: non-link container entities (listitem, article, etc.)
        // Uses Playwright locator calls per entity
        // ============================

        console.log(`[GenericExtractor] Container mode found ${entityLocators.length} entities`);

        // PERFORMANCE: Cap at 50 entities to prevent timeout on large pages
        const MAX_ENTITIES = 50;
        if (entityLocators.length > MAX_ENTITIES) {
          console.log(`[GenericExtractor] Capping ${entityLocators.length} entities to ${MAX_ENTITIES} (performance guard)`);
          entityLocators = entityLocators.slice(0, MAX_ENTITIES);
          debugInfo.selectorsFound.capped_at = MAX_ENTITIES;
        }

        // Her entity'den veri çıkar
        for (const entity of entityLocators) {
          try {
            const item = {};

            // Company name — config role first
            if (config.name_role) {
              const nameRoleOpts = this.parseRoleOptions(config.name_role);
              const nameRoleName = config.name_role.split('[')[0].split(' ')[0].trim();
              try {
                const nameEl = entity.getByRole(nameRoleName, nameRoleOpts);
                item.company_name = await this.quickText(nameEl.first());
              } catch { /* ignore */ }
            }
            // Fallback: config CSS selector
            if (!item.company_name && config.name_selector) {
              try {
                item.company_name = await this.quickText(entity.locator(config.name_selector).first());
              } catch { /* ignore */ }
            }
            // Fallback: any heading inside entity (h1-h6)
            if (!item.company_name) {
              try {
                const anyHeading = await this.quickText(entity.locator('h1, h2, h3, h4, h5, h6').first());
                if (anyHeading && anyHeading.trim().length > 1) {
                  item.company_name = anyHeading.trim();
                }
              } catch { /* ignore */ }
            }
            // Fallback: first line of entity text (if short enough to be a name)
            if (!item.company_name) {
              try {
                const fullText = await this.quickText(entity) || '';
                const firstLine = fullText.trim().split('\n')[0]?.trim();
                if (firstLine && firstLine.length > 2 && firstLine.length < 100) {
                  item.company_name = firstLine;
                }
              } catch { /* ignore */ }
            }

            // Detail link
            if (config.detail_link_role) {
              try {
                const linkOpts = this.parseRoleOptions(config.detail_link_role);
                const linkEl = entity.getByRole('link', linkOpts);
                const href = await linkEl.first().getAttribute('href').catch(() => null);
                if (href) {
                  item.detail_url = href.startsWith('http') ? href : new URL(href, page.url()).href;
                }
              } catch { /* ignore */ }
            }
            if (!item.detail_url && config.detail_link_selector) {
              try {
                const href = await entity.locator(config.detail_link_selector).first().getAttribute('href').catch(() => null);
                if (href) {
                  item.detail_url = href.startsWith('http') ? href : new URL(href, page.url()).href;
                }
              } catch { /* ignore */ }
            }
            // Fallback: first valid <a> link inside entity (skip mailto, tel, hash, invalid paths)
            if (!item.detail_url) {
              try {
                const allLinks = await entity.locator('a[href]').all();
                for (const link of allLinks) {
                  const href = await link.getAttribute('href').catch(() => null);
                  if (!href) continue;
                  if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#')) continue;
                  const fullUrl = href.startsWith('http') ? href : new URL(href, page.url()).href;
                  if (this.isValidDetailUrl(fullUrl, page.url())) {
                    item.detail_url = fullUrl;
                    break;
                  }
                }
              } catch { /* ignore */ }
            }

            // Email (listing sayfasında varsa)
            if (config.email_selector) {
              item.email = await this.extractEmail(entity, config.email_selector);
            }

            // Phone (listing sayfasında varsa)
            if (config.phone_selector) {
              item.phone = await this.extractText(entity, config.phone_selector);
            }

            // Country
            if (config.country_selector) {
              item.country = await this.extractText(entity, config.country_selector);
            }

            // Validate detail_url — filter out blog, homepage, login, etc.
            if (item.detail_url && !this.isValidDetailUrl(item.detail_url, page.url())) {
              item.detail_url = null;
            }

            // Company name varsa listeye ekle
            if (item.company_name && item.company_name.trim()) {
              item.company_name = item.company_name.trim();
              entities.push(item);
            }

          } catch (entityErr) {
            debugInfo.errors.push(`Entity extraction error: ${entityErr.message}`);
          }
        }
        } // end non-link container path
      }

    } catch (err) {
      debugInfo.errors.push(`Listing extraction error: ${err.message}`);
    }

    console.log(`[GenericExtractor] Extracted ${entities.length} entities from listing (mode: ${debugInfo.mode})`);
    return { entities, debugInfo };
  }

  /**
   * Detail sayfasından contact bilgisi çıkar.
   * @param {Page} page - Playwright Page (already navigated to detail URL)
   * @param {Object} config - Claude'un ürettiği detail config
   * @returns {Object} - { email, phone, website, contact_name, job_title, address, country }
   */
  async extractDetail(page, config) {
    const result = {
      email: null, phone: null, website: null,
      contact_name: null, job_title: null, address: null, country: null
    };

    try {
      // Email — config selector first
      if (config.email_selector) {
        result.email = await this.extractEmail(page, config.email_selector);
      }
      // Fallback: sayfadaki ilk mailto link
      if (!result.email) {
        try {
          const mailtoLink = page.locator('a[href^="mailto:"]').first();
          const mailto = await mailtoLink.getAttribute('href').catch(() => null);
          if (mailto) result.email = mailto.replace('mailto:', '').split('?')[0].trim();
        } catch { /* ignore */ }
      }
      // Fallback: sayfada @ içeren text
      if (!result.email) {
        try {
          const bodyText = await page.locator('body').textContent().catch(() => '');
          const emailMatch = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
          if (emailMatch) result.email = emailMatch[0];
        } catch { /* ignore */ }
      }

      // Phone — config selector first
      if (config.phone_selector) {
        result.phone = await this.extractText(page, config.phone_selector);
      }
      // Fallback: tel link
      if (!result.phone) {
        try {
          const telLink = page.locator('a[href^="tel:"]').first();
          const tel = await telLink.getAttribute('href').catch(() => null);
          if (tel) result.phone = tel.replace('tel:', '').trim();
        } catch { /* ignore */ }
      }

      // Website — external link
      if (config.website_selector) {
        try {
          const href = await page.locator(config.website_selector).first().getAttribute('href').catch(() => null);
          if (href && href.startsWith('http')) result.website = href;
        } catch { /* ignore */ }
      }

      // Contact name
      if (config.contact_name_selector) {
        result.contact_name = await this.extractText(page, config.contact_name_selector);
      }

      // Address
      if (config.address_selector) {
        result.address = await this.extractText(page, config.address_selector);
      }

      // Country
      if (config.country_selector) {
        result.country = await this.extractText(page, config.country_selector);
      }

    } catch (err) {
      console.error(`[GenericExtractor] Detail extraction error: ${err.message}`);
    }

    return result;
  }

  /**
   * Table sayfasından veri çıkar (config-driven).
   * @param {Page} page - Playwright Page
   * @param {Object} config - Table extraction config
   * @returns {{ entities: Array, debugInfo: Object }}
   */
  async extractTable(page, config) {
    const debugInfo = { selectorsFound: {}, errors: [] };
    const entities = [];

    try {
      // Table header mapping
      const tableSelector = config.table_selector || 'table';
      const table = page.locator(tableSelector).first();

      // Header row
      const headers = [];
      if (config.header_row_selector) {
        const headerCells = await table.locator(config.header_row_selector).all();
        for (const cell of headerCells) {
          headers.push(await cell.textContent().catch(() => ''));
        }
      }
      debugInfo.selectorsFound.headers = headers.length;

      // Data rows
      const rowSelector = config.data_row_selector || 'tbody tr';
      const rows = await table.locator(rowSelector).all();
      debugInfo.selectorsFound.dataRows = rows.length;

      // Column mapping (config tells us which column index = which field)
      const colMap = config.column_map || {};
      // e.g. { "0": "company_name", "1": "email", "2": "phone" }

      for (const row of rows) {
        try {
          const cells = await row.locator('td').all();
          const item = {};

          for (const [colIdx, fieldName] of Object.entries(colMap)) {
            const idx = parseInt(colIdx);
            if (cells[idx]) {
              item[fieldName] = await cells[idx].textContent().catch(() => null);
              if (item[fieldName]) item[fieldName] = item[fieldName].trim();
            }
          }

          if (item.company_name || item.email) {
            entities.push(item);
          }
        } catch (rowErr) {
          debugInfo.errors.push(`Row extraction error: ${rowErr.message}`);
        }
      }
    } catch (err) {
      debugInfo.errors.push(`Table extraction error: ${err.message}`);
    }

    console.log(`[GenericExtractor] Extracted ${entities.length} entities from table`);
    return { entities, debugInfo };
  }

  // ---------------------------------------------------------------------------
  // FAST EXTRACTION — page.evaluate() based (no locator overhead)
  // ---------------------------------------------------------------------------

  /**
   * Bulk extract link entities using page.evaluate().
   * 14 entities: 5-10 minutes with locators → ~100ms with page.evaluate.
   * Includes navigation/business link filtering inside the browser context.
   * @param {Page} page - Playwright Page (already navigated)
   * @param {Object} config - Extraction config
   * @returns {Array} entities with company_name, detail_url, email, phone, country
   */
  async bulkExtractFromPage(page, config) {
    return await page.evaluate((cfg) => {
      const results = [];
      const origin = window.location.origin;
      const currentPath = window.location.pathname;

      // ---- Navigation link detection (mirrors isNavigationLink) ----
      function isNavLink(href, text) {
        const navPatterns = [
          /^\/$/, /^\/en\/?$/, /^\/[a-z]{2}\/?$/,
          /\/(login|signup|register|account)\b/i,
          /\/(about|contact|privacy|terms|faq|help)\b/i,
          /\/(forum|blog|news|magazine|events|jobs|housing)\b/i,
          /\/(classifieds|properties|services|network|pictures)\b/i,
          /\/#/,
          /^(https?:\/\/)?(www\.)?(facebook|twitter|linkedin|instagram|youtube|google|apple)/i,
        ];
        for (const p of navPatterns) {
          if (p.test(href)) return true;
        }
        const navTexts = ['home', 'login', 'sign up', 'more', 'search', 'menu', 'next', 'previous',
          'back', 'all', 'see all', 'view all', 'read more', 'close', 'ok', 'cancel'];
        if (navTexts.includes(text.toLowerCase().trim())) return true;
        return false;
      }

      // ---- Business profile detection (mirrors isBusinessProfileLink) ----
      function isBizLink(href) {
        const bizPatterns = [
          /\/business\/\d+[_-]/i, /\/exhibitor\//i, /\/company\//i,
          /\/member\//i, /\/profile\//i, /\/vendor\//i, /\/supplier\//i,
          /\/directory\/[^/]+\/[^/]+\.\w+$/i,
          /\/\d+[_-][a-z].*\.\w+$/i,
        ];
        for (const p of bizPatterns) {
          if (p.test(href)) return true;
        }
        return false;
      }

      // ---- Valid detail URL check (mirrors isValidDetailUrl) ----
      function isValidDetail(href) {
        try {
          const parsed = new URL(href, origin);
          const path = parsed.pathname.toLowerCase();
          if (parsed.origin + parsed.pathname === origin + currentPath) return false;
          const invalidPaths = ['/blog','/news','/about','/contact','/login','/signup','/register',
            '/privacy','/terms','/faq','/help','/sitemap','/search','/category','/tag',
            '/archive','/feed','/rss','/cart','/checkout','/account','/settings','/wp-admin','/admin'];
          for (const inv of invalidPaths) {
            if (path === inv || path.startsWith(inv + '/')) return false;
          }
          if (parsed.hostname !== window.location.hostname) return false;
          if (path === '/' || /^\/[a-z]{2}\/?$/.test(path)) return false;
          const segments = path.split('/').filter(Boolean);
          if (segments.length >= 4) {
            const last = segments[segments.length - 1];
            if (/^\d+_[a-z-]+$/.test(last)) return false;
          }
          return true;
        } catch { return false; }
      }

      // ---- Collect all links, filter ----
      const selector = cfg.entity_selector || 'a[href]';
      const allLinks = document.querySelectorAll(selector);

      for (const link of allLinks) {
        const href = link.getAttribute('href') || '';
        const text = link.textContent?.trim() || '';
        if (!text || text.length < 3 || text.length > 100) continue;
        if (!href) continue;

        // Build full URL
        let fullUrl;
        try {
          fullUrl = href.startsWith('http') ? href : new URL(href, origin).href;
        } catch { continue; }

        // Skip navigation links
        if (isNavLink(href, text)) continue;

        // Prefer business profile links, but accept any valid detail URL
        const isBusiness = isBizLink(href);
        const isValid = isValidDetail(fullUrl);
        if (!isBusiness && !isValid) continue;

        // Check for email on the page around this link
        let email = null;
        const parent = link.closest('li, article, div, tr, section');
        if (parent) {
          const mailtoEl = parent.querySelector('a[href^="mailto:"]');
          if (mailtoEl) email = mailtoEl.href.replace('mailto:', '').split('?')[0].trim();
          if (!email) {
            const parentText = parent.textContent || '';
            const emailMatch = parentText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            if (emailMatch) email = emailMatch[0];
          }
        }

        results.push({
          company_name: text,
          detail_url: fullUrl,
          email,
          phone: null,
          country: null
        });
      }

      return results;
    }, config);
  }

  /**
   * Fast detail page extraction using page.evaluate().
   * Replaces slow Playwright locator-based extractDetail() for performance.
   * Single page.evaluate call: ~10ms vs locator-based: ~5-10 seconds.
   * @param {Page} page - Playwright Page (already navigated to detail URL)
   * @param {Object} config - Detail extraction config
   * @returns {Object} { email, phone, website, contact_name, job_title, address, country }
   */
  async quickExtractDetail(page, config) {
    return await page.evaluate((cfg) => {
      const result = { email: null, phone: null, website: null, contact_name: null, job_title: null, address: null, country: null };

      // Email — mailto link
      const mailtoEl = document.querySelector('a[href^="mailto:"]');
      if (mailtoEl) {
        result.email = mailtoEl.href.replace('mailto:', '').split('?')[0].trim();
      }
      // Fallback: text'te @ ara
      if (!result.email) {
        const bodyText = document.body?.textContent || '';
        const match = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (match) result.email = match[0];
      }

      // Phone — tel link
      const telEl = document.querySelector('a[href^="tel:"]');
      if (telEl) {
        result.phone = telEl.href.replace('tel:', '').trim();
      }

      // Website — external link (not same domain, not social media)
      const externalLinks = document.querySelectorAll('a[href^="http"]');
      for (const link of externalLinks) {
        try {
          const url = new URL(link.href);
          if (url.hostname !== window.location.hostname
              && !url.hostname.includes('google') && !url.hostname.includes('facebook')
              && !url.hostname.includes('twitter') && !url.hostname.includes('instagram')
              && !url.hostname.includes('linkedin') && !url.hostname.includes('youtube')) {
            result.website = link.href;
            break;
          }
        } catch { /* ignore */ }
      }

      // Config-based selectors
      if (cfg.email_selector && !result.email) {
        const el = document.querySelector(cfg.email_selector);
        if (el) {
          const href = el.getAttribute('href') || '';
          if (href.startsWith('mailto:')) {
            result.email = href.replace('mailto:', '').split('?')[0].trim();
          } else if (el.textContent?.includes('@')) {
            const m = el.textContent.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            if (m) result.email = m[0];
          }
        }
      }

      if (cfg.address_selector) {
        const addrEl = document.querySelector(cfg.address_selector);
        if (addrEl) result.address = addrEl.textContent?.trim();
      }

      if (cfg.contact_name_selector) {
        const nameEl = document.querySelector(cfg.contact_name_selector);
        if (nameEl) result.contact_name = nameEl.textContent?.trim();
      }

      if (cfg.country_selector) {
        const countryEl = document.querySelector(cfg.country_selector);
        if (countryEl) result.country = countryEl.textContent?.trim();
      }

      return result;
    }, config);
  }

  // ---------------------------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Extract email from a locator using a selector.
   * Tries mailto href first, then text content.
   * @param {Locator} locator - Playwright locator (page or entity)
   * @param {string} selector - CSS selector
   * @returns {string|null}
   */
  async extractEmail(locator, selector) {
    try {
      const el = locator.locator(selector).first();
      // Try mailto href
      const href = await el.getAttribute('href').catch(() => null);
      if (href && href.startsWith('mailto:')) {
        return href.replace('mailto:', '').split('?')[0].trim();
      }
      // Try text content with @ sign
      const text = await el.textContent().catch(() => null);
      if (text && text.includes('@')) {
        const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        return match ? match[0] : null;
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Extract text content with a timeout guard.
   * Prevents hanging on slow/broken elements.
   * @param {Locator} locator - Playwright locator
   * @param {number} timeoutMs - Max wait time (default 5000ms)
   * @returns {string|null}
   */
  async quickText(locator, timeoutMs = 5000) {
    try {
      return await Promise.race([
        locator.textContent(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('quickText timeout')), timeoutMs))
      ]);
    } catch {
      return null;
    }
  }

  /**
   * Extract text content from a locator using a selector.
   * @param {Locator} locator - Playwright locator (page or entity)
   * @param {string} selector - CSS selector
   * @returns {string|null}
   */
  async extractText(locator, selector) {
    try {
      const text = await locator.locator(selector).first().textContent().catch(() => null);
      return text ? text.trim() : null;
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Parse role options from AXTree-style role string.
   * Examples:
   *   "heading[3]" → { level: 3 }
   *   "link 'View Profile'" → { name: 'View Profile' }
   *   "heading 'Company Name'" → { name: 'Company Name' }
   * @param {string} roleString
   * @returns {Object} Playwright role options
   */
  parseRoleOptions(roleString) {
    const opts = {};

    // Name: 'Some Text' or "Some Text"
    const nameMatch = roleString.match(/['"]([^'"]+)['"]/);
    if (nameMatch) opts.name = nameMatch[1];

    // Level: [N]
    const levelMatch = roleString.match(/\[(\d+)\]/);
    if (levelMatch) opts.level = parseInt(levelMatch[1]);

    return opts;
  }

  /**
   * Check if a link is a navigation/utility link (not a business entity).
   * @param {string} href - Link URL
   * @param {string} text - Link text content
   * @returns {boolean} true if this is a navigation link
   */
  isNavigationLink(href, text) {
    const navPatterns = [
      /^\/$/, // Homepage
      /^\/en\/?$/, /^\/[a-z]{2}\/?$/, // Language root
      /\/(login|signup|register|account)\b/i,
      /\/(about|contact|privacy|terms|faq|help)\b/i,
      /\/(forum|blog|news|magazine|events|jobs|housing)\b/i,
      /\/(classifieds|properties|services|network|pictures)\b/i,
      /\/#/, // Anchor links
      /^(https?:\/\/)?(www\.)?(facebook|twitter|linkedin|instagram|youtube|google|apple)/i,
    ];

    for (const pattern of navPatterns) {
      if (pattern.test(href)) return true;
    }

    // Very short generic text — likely navigation
    const navTexts = ['home', 'login', 'sign up', 'more', 'search', 'menu', 'next', 'previous',
      'back', 'all', 'see all', 'view all', 'read more', 'close', 'ok', 'cancel'];
    if (navTexts.includes(text.toLowerCase().trim())) return true;

    return false;
  }

  /**
   * Check if a link URL looks like a business/company profile page.
   * Matches URLs with numeric IDs + slugs, or common profile path patterns.
   * @param {string} href - Link URL
   * @returns {boolean} true if this looks like a business profile link
   */
  isBusinessProfileLink(href) {
    const businessPatterns = [
      /\/business\/\d+[_-]/i,
      /\/exhibitor\//i,
      /\/company\//i,
      /\/member\//i,
      /\/profile\//i,
      /\/vendor\//i,
      /\/supplier\//i,
      /\/directory\/[^/]+\/[^/]+\.\w+$/i, // /directory/category/company.html
      /\/\d+[_-][a-z].*\.\w+$/i, // Generic numeric ID + slug + extension pattern
    ];

    for (const pattern of businessPatterns) {
      if (pattern.test(href)) return true;
    }

    return false;
  }

  /**
   * Check if a detail URL is a valid profile/company page (not blog, homepage, login, etc.)
   * @param {string} url - Detail URL to validate
   * @param {string} baseUrl - Listing page URL (for same-domain check)
   * @returns {boolean}
   */
  isValidDetailUrl(url, baseUrl) {
    try {
      const parsed = new URL(url);
      const baseParsed = new URL(baseUrl);
      const path = parsed.pathname.toLowerCase();

      // Same page (path match) — invalid
      if (parsed.origin + parsed.pathname === baseParsed.origin + baseParsed.pathname) return false;

      // Known invalid paths — blog, admin, login, generic pages
      const invalidPaths = [
        '/blog', '/news', '/about', '/contact', '/login', '/signup', '/register',
        '/privacy', '/terms', '/faq', '/help', '/sitemap', '/search',
        '/category', '/tag', '/archive', '/feed', '/rss',
        '/cart', '/checkout', '/account', '/settings',
        '/wp-admin', '/admin'
      ];

      for (const invalid of invalidPaths) {
        if (path === invalid || path.startsWith(invalid + '/')) return false;
      }

      // Different domain — probably external link, invalid
      if (parsed.hostname !== baseParsed.hostname) return false;

      // Path too short (/ or /en/) — homepage
      if (path === '/' || /^\/[a-z]{2}\/?$/.test(path)) return false;

      // Category page pattern: /business/africa/ghana/29_moving/ (many segments, ends with number_category)
      const segments = path.split('/').filter(Boolean);
      if (segments.length >= 4) {
        const lastSegment = segments[segments.length - 1];
        // Pattern: "29_moving" or "191_moving-companies" without file extension → category page
        if (/^\d+_[a-z-]+$/.test(lastSegment)) return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if entity_role is a heading role (triggers anchor-based extraction).
   * Examples: "heading[5]", "heading[3]", "heading"
   * @param {string} role - entity_role from config
   * @returns {boolean}
   */
  isHeadingRole(role) {
    if (!role) return false;
    return role.startsWith('heading');
  }
}

module.exports = new GenericExtractor();
