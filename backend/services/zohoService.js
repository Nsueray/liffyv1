const axios = require('axios');
const db = require('../db');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Datacenter → base URL mapping
const DATACENTER_MAP = {
  'com':    { accounts: 'https://accounts.zoho.com',    api: 'https://www.zohoapis.com' },
  'eu':     { accounts: 'https://accounts.zoho.eu',     api: 'https://www.zohoapis.eu' },
  'in':     { accounts: 'https://accounts.zoho.in',     api: 'https://www.zohoapis.in' },
  'com.au': { accounts: 'https://accounts.zoho.com.au', api: 'https://www.zohoapis.com.au' },
  'jp':     { accounts: 'https://accounts.zoho.jp',     api: 'https://www.zohoapis.jp' },
  'ca':     { accounts: 'https://accounts.zoho.ca',     api: 'https://www.zohoapis.ca' }
};

// ISO alpha-2 → full country name (common ones)
const COUNTRY_MAP = {
  'US': 'United States', 'GB': 'United Kingdom', 'UK': 'United Kingdom',
  'CA': 'Canada', 'AU': 'Australia', 'DE': 'Germany', 'FR': 'France',
  'IT': 'Italy', 'ES': 'Spain', 'NL': 'Netherlands', 'BE': 'Belgium',
  'AT': 'Austria', 'CH': 'Switzerland', 'SE': 'Sweden', 'NO': 'Norway',
  'DK': 'Denmark', 'FI': 'Finland', 'IE': 'Ireland', 'PT': 'Portugal',
  'PL': 'Poland', 'CZ': 'Czech Republic', 'RO': 'Romania', 'HU': 'Hungary',
  'GR': 'Greece', 'TR': 'Turkey', 'RU': 'Russia', 'UA': 'Ukraine',
  'JP': 'Japan', 'CN': 'China', 'KR': 'South Korea', 'IN': 'India',
  'SG': 'Singapore', 'MY': 'Malaysia', 'TH': 'Thailand', 'ID': 'Indonesia',
  'PH': 'Philippines', 'VN': 'Vietnam', 'TW': 'Taiwan', 'HK': 'Hong Kong',
  'NZ': 'New Zealand', 'ZA': 'South Africa', 'NG': 'Nigeria', 'EG': 'Egypt',
  'KE': 'Kenya', 'GH': 'Ghana', 'BR': 'Brazil', 'MX': 'Mexico',
  'AR': 'Argentina', 'CL': 'Chile', 'CO': 'Colombia', 'PE': 'Peru',
  'AE': 'United Arab Emirates', 'SA': 'Saudi Arabia', 'IL': 'Israel',
  'QA': 'Qatar', 'KW': 'Kuwait', 'BH': 'Bahrain', 'OM': 'Oman',
  'PK': 'Pakistan', 'BD': 'Bangladesh', 'LK': 'Sri Lanka',
  'HR': 'Croatia', 'RS': 'Serbia', 'BG': 'Bulgaria', 'SK': 'Slovakia',
  'SI': 'Slovenia', 'LT': 'Lithuania', 'LV': 'Latvia', 'EE': 'Estonia'
};

function getUrls(datacenter) {
  return DATACENTER_MAP[datacenter] || DATACENTER_MAP['com'];
}

function countryCodeToName(code) {
  if (!code) return null;
  const upper = code.toUpperCase().trim();
  return COUNTRY_MAP[upper] || upper;
}

/**
 * Get a valid access token for an organizer.
 * Refreshes from Zoho if cached token is expired or missing.
 * Never throws — returns { success, access_token } or { success: false, error }.
 */
async function getAccessToken(organizerId) {
  try {
    const orgRes = await db.query(
      `SELECT zoho_client_id, zoho_client_secret, zoho_refresh_token,
              zoho_access_token, zoho_access_token_expires_at, zoho_datacenter
       FROM organizers WHERE id = $1`,
      [organizerId]
    );

    if (orgRes.rows.length === 0) {
      return { success: false, error: 'Organizer not found' };
    }

    const org = orgRes.rows[0];

    if (!org.zoho_client_id || !org.zoho_client_secret || !org.zoho_refresh_token) {
      return { success: false, error: 'Zoho CRM credentials not configured' };
    }

    // Check if cached token is still valid (with 5 min buffer)
    if (org.zoho_access_token && org.zoho_access_token_expires_at) {
      const expiresAt = new Date(org.zoho_access_token_expires_at);
      const bufferMs = 5 * 60 * 1000;
      if (expiresAt.getTime() - bufferMs > Date.now()) {
        return { success: true, access_token: org.zoho_access_token };
      }
    }

    // Refresh the token
    const urls = getUrls(org.zoho_datacenter);
    const res = await axios.post(`${urls.accounts}/oauth/v2/token`, null, {
      params: {
        grant_type: 'refresh_token',
        client_id: org.zoho_client_id,
        client_secret: org.zoho_client_secret,
        refresh_token: org.zoho_refresh_token
      },
      timeout: 15000
    });

    const { access_token, expires_in } = res.data;

    if (!access_token) {
      const errMsg = res.data.error || 'No access_token in response';
      return { success: false, error: `Token refresh failed: ${errMsg}` };
    }

    // Cache the new token (expires_in is in seconds)
    const expiresAt = new Date(Date.now() + (expires_in || 3600) * 1000);
    await db.query(
      `UPDATE organizers SET zoho_access_token = $1, zoho_access_token_expires_at = $2
       WHERE id = $3`,
      [access_token, expiresAt.toISOString(), organizerId]
    );

    return { success: true, access_token };
  } catch (err) {
    const detail = err.response?.data?.error || err.message;
    return { success: false, error: `Token refresh failed: ${detail}` };
  }
}

/**
 * Test connection to Zoho CRM by calling the org endpoint.
 * Never throws — returns { success, org_name } or { success: false, error }.
 */
async function testConnection(organizerId) {
  try {
    const tokenResult = await getAccessToken(organizerId);
    if (!tokenResult.success) {
      return tokenResult;
    }

    // Get datacenter for API URL
    const orgRes = await db.query(
      `SELECT zoho_datacenter FROM organizers WHERE id = $1`,
      [organizerId]
    );
    const datacenter = orgRes.rows[0]?.zoho_datacenter || 'com';
    const urls = getUrls(datacenter);

    const res = await axios.get(`${urls.api}/crm/v7/org`, {
      headers: { Authorization: `Zoho-oauthtoken ${tokenResult.access_token}` },
      timeout: 15000
    });

    const orgData = res.data?.org?.[0];
    if (!orgData) {
      return { success: false, error: 'Could not retrieve Zoho organization info' };
    }

    return { success: true, org_name: orgData.company_name || orgData.org_name || 'Connected' };
  } catch (err) {
    const detail = err.response?.data?.message || err.response?.data?.code || err.message;
    return { success: false, error: `Connection test failed: ${detail}` };
  }
}

/**
 * Map a Liffy person + affiliation to a Zoho CRM record.
 */
function mapPersonToZoho(person, affiliation) {
  const record = {
    Email: person.email,
    First_Name: person.first_name || '',
    Last_Name: person.last_name || person.email.split('@')[0],
    Lead_Source: 'Liffy'
  };

  if (affiliation) {
    record.Company = affiliation.company_name || '[Unknown]';
    if (affiliation.position) record.Designation = affiliation.position;
    if (affiliation.phone) record.Phone = affiliation.phone;
    if (affiliation.country_code) record.Country = countryCodeToName(affiliation.country_code);
    if (affiliation.city) record.City = affiliation.city;
    if (affiliation.website) record.Website = affiliation.website;
  } else {
    record.Company = '[Unknown]';
  }

  return record;
}

/**
 * Push persons to Zoho CRM (Leads or Contacts).
 * Handles create vs update based on existing zoho_push_log entries.
 * Batches in groups of 100 per Zoho API limits.
 * Never throws — returns { success, pushed, failed, results[] }.
 */
async function pushPersons(organizerId, personIds, module = 'Leads', userId = null) {
  if (!personIds || personIds.length === 0) {
    return { success: true, pushed: 0, failed: 0, results: [] };
  }

  if (!['Leads', 'Contacts'].includes(module)) {
    return { success: false, error: 'Module must be Leads or Contacts' };
  }

  // Get access token
  const tokenResult = await getAccessToken(organizerId);
  if (!tokenResult.success) {
    return { success: false, error: tokenResult.error, pushed: 0, failed: 0, results: [] };
  }

  // Get datacenter
  const orgRes = await db.query(
    `SELECT zoho_datacenter FROM organizers WHERE id = $1`,
    [organizerId]
  );
  const datacenter = orgRes.rows[0]?.zoho_datacenter || 'com';
  const urls = getUrls(datacenter);

  // Fetch persons with latest affiliation
  const personsRes = await db.query(
    `SELECT p.id, p.email, p.first_name, p.last_name,
            a.company_name, a.position, a.country_code, a.city, a.website, a.phone
     FROM persons p
     LEFT JOIN LATERAL (
       SELECT company_name, position, country_code, city, website, phone
       FROM affiliations
       WHERE person_id = p.id AND organizer_id = $1
       ORDER BY created_at DESC LIMIT 1
     ) a ON true
     WHERE p.id = ANY($2) AND p.organizer_id = $1`,
    [organizerId, personIds]
  );

  if (personsRes.rows.length === 0) {
    return { success: true, pushed: 0, failed: 0, results: [], error: 'No matching persons found' };
  }

  // Check existing zoho_record_ids for update vs create
  const existingRes = await db.query(
    `SELECT DISTINCT ON (person_id) person_id, zoho_record_id
     FROM zoho_push_log
     WHERE organizer_id = $1 AND person_id = ANY($2)
       AND zoho_module = $3 AND status = 'success' AND zoho_record_id IS NOT NULL
     ORDER BY person_id, pushed_at DESC`,
    [organizerId, personIds, module]
  );

  const existingMap = {};
  for (const row of existingRes.rows) {
    existingMap[row.person_id] = row.zoho_record_id;
  }

  // Split into creates and updates
  const toCreate = [];
  const toUpdate = [];

  for (const person of personsRes.rows) {
    const affiliation = person.company_name ? {
      company_name: person.company_name,
      position: person.position,
      country_code: person.country_code,
      city: person.city,
      website: person.website,
      phone: person.phone
    } : null;

    const zohoRecord = mapPersonToZoho(person, affiliation);
    const entry = { person, zohoRecord, affiliation };

    if (existingMap[person.id]) {
      entry.zoho_record_id = existingMap[person.id];
      zohoRecord.id = existingMap[person.id];
      toUpdate.push(entry);
    } else {
      toCreate.push(entry);
    }
  }

  const allResults = [];
  let pushed = 0;
  let failed = 0;

  // Process creates in batches of 100
  for (let i = 0; i < toCreate.length; i += 100) {
    const batch = toCreate.slice(i, i + 100);
    const batchResults = await sendBatch(
      urls, tokenResult.access_token, module, 'create', batch,
      organizerId, userId
    );
    for (const r of batchResults) {
      allResults.push(r);
      if (r.status === 'success') pushed++;
      else failed++;
    }
    if (i + 100 < toCreate.length) await sleep(100);
  }

  // Process updates in batches of 100
  for (let i = 0; i < toUpdate.length; i += 100) {
    const batch = toUpdate.slice(i, i + 100);
    const batchResults = await sendBatch(
      urls, tokenResult.access_token, module, 'update', batch,
      organizerId, userId
    );
    for (const r of batchResults) {
      allResults.push(r);
      if (r.status === 'success') pushed++;
      else failed++;
    }
    if (i + 100 < toUpdate.length) await sleep(100);
  }

  return { success: true, pushed, failed, results: allResults };
}

/**
 * Send a batch of records to Zoho CRM and log results.
 * @param {object} urls - Datacenter URLs
 * @param {string} accessToken - OAuth access token
 * @param {string} module - 'Leads' or 'Contacts'
 * @param {string} action - 'create' or 'update'
 * @param {Array} batch - Array of { person, zohoRecord, affiliation, zoho_record_id? }
 * @param {string} organizerId
 * @param {string|null} userId
 * @returns {Array} Per-record results
 */
async function sendBatch(urls, accessToken, module, action, batch, organizerId, userId) {
  const results = [];
  const payload = { data: batch.map(b => b.zohoRecord) };

  // For creates, add duplicate_check_fields to avoid duplicates by email
  if (action === 'create') {
    payload.duplicate_check_fields = ['Email'];
  }

  try {
    const method = action === 'create' ? 'post' : 'put';
    const res = await axios({
      method,
      url: `${urls.api}/crm/v7/${module}`,
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json'
      },
      data: payload,
      timeout: 30000
    });

    const responseData = res.data?.data || [];

    for (let j = 0; j < batch.length; j++) {
      const entry = batch[j];
      const zohoResult = responseData[j] || {};
      const isSuccess = zohoResult.code === 'SUCCESS';
      const zohoRecordId = zohoResult.details?.id || entry.zoho_record_id || null;
      const effectiveAction = zohoResult.action || action;
      const errorMsg = isSuccess ? null : (zohoResult.message || zohoResult.code || 'Unknown error');

      // Log to zoho_push_log
      try {
        await db.query(
          `INSERT INTO zoho_push_log
           (organizer_id, person_id, zoho_module, zoho_record_id, action, status, error_message, field_snapshot, pushed_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            organizerId,
            entry.person.id,
            module,
            zohoRecordId,
            effectiveAction === 'insert' ? 'create' : (effectiveAction === 'update' ? 'update' : action),
            isSuccess ? 'success' : 'failed',
            errorMsg,
            JSON.stringify(entry.zohoRecord),
            userId
          ]
        );
      } catch (logErr) {
        console.error('[Zoho] Push log insert error:', logErr.message);
      }

      results.push({
        person_id: entry.person.id,
        email: entry.person.email,
        zoho_record_id: zohoRecordId,
        action: effectiveAction === 'insert' ? 'create' : (effectiveAction === 'update' ? 'update' : action),
        status: isSuccess ? 'success' : 'failed',
        error: errorMsg
      });
    }
  } catch (err) {
    // Entire batch failed — log each as failed
    const errorMsg = err.response?.data?.message || err.response?.data?.code || err.message;
    for (const entry of batch) {
      try {
        await db.query(
          `INSERT INTO zoho_push_log
           (organizer_id, person_id, zoho_module, zoho_record_id, action, status, error_message, field_snapshot, pushed_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            organizerId,
            entry.person.id,
            module,
            entry.zoho_record_id || null,
            action,
            'failed',
            errorMsg,
            JSON.stringify(entry.zohoRecord),
            userId
          ]
        );
      } catch (logErr) {
        console.error('[Zoho] Push log insert error:', logErr.message);
      }

      results.push({
        person_id: entry.person.id,
        email: entry.person.email,
        zoho_record_id: null,
        action,
        status: 'failed',
        error: errorMsg
      });
    }
  }

  return results;
}

module.exports = {
  getAccessToken,
  testConnection,
  mapPersonToZoho,
  pushPersons,
  getUrls,
  countryCodeToName
};
