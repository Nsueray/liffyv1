const db = require('../db');

const createLog = async ({ organizerId, campaignId, templateId, recipientEmail, recipientData }) => {
  const query = `
    INSERT INTO email_logs (organizer_id, campaign_id, template_id, recipient_email, recipient_data)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `;
  const values = [organizerId, campaignId, templateId, recipientEmail, recipientData];
  const result = await db.query(query, values);
  return result.rows[0];
};

const updateLogStatus = async (logId, status, providerResponse = null) => {
  const query = `
    UPDATE email_logs 
    SET status = $2, 
        provider_response = $3,
        sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END
    WHERE id = $1
    RETURNING *
  `;
  const values = [logId, status, providerResponse];
  const result = await db.query(query, values);
  return result.rows[0];
};

const getLogsByCampaign = async (campaignId, limit = 100, offset = 0) => {
  const query = `
    SELECT * FROM email_logs 
    WHERE campaign_id = $1
    ORDER BY created_at DESC
    LIMIT $2 OFFSET $3
  `;
  const result = await db.query(query, [campaignId, limit, offset]);
  return result.rows;
};

const getLogsByOrganizer = async (organizerId, { limit = 100, offset = 0 } = {}) => {
  const query = `
    SELECT * FROM email_logs 
    WHERE organizer_id = $1
    ORDER BY created_at DESC
    LIMIT $2 OFFSET $3
  `;
  const result = await db.query(query, [organizerId, limit, offset]);
  return result.rows;
};

const getLogById = async (id) => {
  const query = 'SELECT * FROM email_logs WHERE id = $1';
  const result = await db.query(query, [id]);
  return result.rows[0];
};

module.exports = {
  createLog,
  updateLogStatus,
  getLogsByCampaign,
  getLogsByOrganizer,
  getLogById
};
