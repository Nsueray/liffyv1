const db = require('../db');

const createCampaign = async (organizerId, templateId, name, scheduledAt = null) => {
  const query = `
    INSERT INTO campaigns (organizer_id, template_id, name, scheduled_at)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `;
  const values = [organizerId, templateId, name, scheduledAt];
  const result = await db.query(query, values);
  return result.rows[0];
};

const getCampaignsByOrganizer = async (organizerId) => {
  const query = `
    SELECT c.*, t.subject as template_subject, t.name as template_name
    FROM campaigns c
    LEFT JOIN email_templates t ON c.template_id = t.id
    WHERE c.organizer_id = $1
    ORDER BY c.created_at DESC
  `;
  const result = await db.query(query, [organizerId]);
  return result.rows;
};

const getCampaignById = async (id) => {
  const query = `
    SELECT c.*, t.subject as template_subject, t.name as template_name, t.body_html, t.body_text
    FROM campaigns c
    LEFT JOIN email_templates t ON c.template_id = t.id
    WHERE c.id = $1
  `;
  const result = await db.query(query, [id]);
  return result.rows[0];
};

const updateCampaignStatus = async (id, status) => {
  const validStatuses = ['draft', 'scheduled', 'sending', 'completed', 'failed'];
  if (!validStatuses.includes(status)) {
    throw new Error('Invalid status');
  }
  const query = `
    UPDATE campaigns 
    SET status = $2
    WHERE id = $1
    RETURNING *
  `;
  const result = await db.query(query, [id, status]);
  return result.rows[0];
};

const deleteCampaign = async (id) => {
  const query = 'DELETE FROM campaigns WHERE id = $1 RETURNING *';
  const result = await db.query(query, [id]);
  return result.rows[0];
};

module.exports = {
  createCampaign,
  getCampaignsByOrganizer,
  getCampaignById,
  updateCampaignStatus,
  deleteCampaign
};
