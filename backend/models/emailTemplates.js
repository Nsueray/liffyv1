const db = require('../db');

const createTemplate = async (organizerId, name, subject, bodyHtml, bodyText = null) => {
  const query = `
    INSERT INTO email_templates (organizer_id, name, subject, body_html, body_text)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `;
  const values = [organizerId, name, subject, bodyHtml, bodyText];
  const result = await db.query(query, values);
  return result.rows[0];
};

const getTemplatesByOrganizer = async (organizerId) => {
  const query = `
    SELECT * FROM email_templates 
    WHERE organizer_id = $1 
    ORDER BY created_at DESC
  `;
  const result = await db.query(query, [organizerId]);
  return result.rows;
};

const getTemplateById = async (id) => {
  const query = 'SELECT * FROM email_templates WHERE id = $1';
  const result = await db.query(query, [id]);
  return result.rows[0];
};

const updateTemplate = async (id, name, subject, bodyHtml, bodyText) => {
  const query = `
    UPDATE email_templates 
    SET name = $2, subject = $3, body_html = $4, body_text = $5
    WHERE id = $1
    RETURNING *
  `;
  const values = [id, name, subject, bodyHtml, bodyText];
  const result = await db.query(query, values);
  return result.rows[0];
};

const deleteTemplate = async (id) => {
  const query = 'DELETE FROM email_templates WHERE id = $1 RETURNING *';
  const result = await db.query(query, [id]);
  return result.rows[0];
};

module.exports = {
  createTemplate,
  getTemplatesByOrganizer,
  getTemplateById,
  updateTemplate,
  deleteTemplate
};
