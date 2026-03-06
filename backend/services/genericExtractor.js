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
    const debugInfo = { selectorsFound: {}, errors: [] };
    const entities = [];

    try {
      // Entity blokları bul — role-based veya CSS fallback
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

      console.log(`[GenericExtractor] Found ${entityLocators.length} entities`);

      // Her entity'den veri çıkar
      for (const entity of entityLocators) {
        try {
          const item = {};

          // Company name
          if (config.name_role) {
            const roleOpts = this.parseRoleOptions(config.name_role);
            const roleName = config.name_role.split('[')[0].split(' ')[0].trim();
            try {
              const nameEl = entity.getByRole(roleName, roleOpts);
              item.company_name = await nameEl.first().textContent().catch(() => null);
            } catch { /* ignore */ }
          }
          if (!item.company_name && config.name_selector) {
            try {
              item.company_name = await entity.locator(config.name_selector).first().textContent().catch(() => null);
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

          // Company name varsa listeye ekle
          if (item.company_name && item.company_name.trim()) {
            item.company_name = item.company_name.trim();
            entities.push(item);
          }

        } catch (entityErr) {
          debugInfo.errors.push(`Entity extraction error: ${entityErr.message}`);
        }
      }

    } catch (err) {
      debugInfo.errors.push(`Listing extraction error: ${err.message}`);
    }

    console.log(`[GenericExtractor] Extracted ${entities.length} entities from listing`);
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
}

module.exports = new GenericExtractor();
