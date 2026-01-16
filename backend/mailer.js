const sgMail = require('@sendgrid/mail');
const config = require('./config');

/**
 * Sends email via SendGrid.
 */
const sendEmail = async ({
  to,
  subject,
  text,
  html,
  fromEmail,
  fromName,
  from_email,   // Also accept snake_case
  from_name,    // Also accept snake_case
  replyTo,
  reply_to,     // Also accept snake_case
  sendgrid_api_key,
  sendgridApiKey
}) => {
  try {
    // Handle both camelCase and snake_case
    const apiKey = sendgrid_api_key || sendgridApiKey || config.SENDGRID_API_KEY;
    const senderEmail = from_email || fromEmail || 'noreply@liffy.app';
    const senderName = from_name || fromName || 'Liffy';
    const replyToEmail = reply_to || replyTo || null;

    if (!apiKey) {
      throw new Error("Missing SendGrid API key");
    }

    if (!to) {
      throw new Error("Missing recipient email");
    }

    sgMail.setApiKey(apiKey);

    const msg = {
      to,
      from: {
        email: senderEmail,
        name: senderName
      },
      subject: subject || '(No Subject)',
      text: text || '',
      html: html || text || ''
    };

    if (replyToEmail) {
      msg.replyTo = replyToEmail;
    }

    console.log(`📧 Sending email to ${to} from ${senderEmail}...`);

    const response = await sgMail.send(msg);

    console.log(`✅ Email sent to ${to}`);
    return {
      success: true,
      provider: 'sendgrid',
      raw: response && response[0] ? {
        statusCode: response[0].statusCode,
        headers: response[0].headers
      } : null
    };
  } catch (error) {
    // Log detailed error
    console.error('❌ Email send error:', error.message);
    
    if (error.response) {
      console.error('SendGrid response:', JSON.stringify(error.response.body, null, 2));
    }
    
    return {
      success: false,
      provider: 'sendgrid',
      error: error.message,
      details: error.response?.body?.errors || null
    };
  }
};

module.exports = { sendEmail };
