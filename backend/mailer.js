const sgMail = require('@sendgrid/mail');
const config = require('./config');

/**
 * Sends email via SendGrid.
 * 
 * Params:
 *  - to: recipient email
 *  - subject
 *  - text
 *  - html
 *  - fromEmail (optional, defaults to config or "noreply@liffy.app")
 *  - fromName  (optional, defaults to "Liffy")
 *  - replyTo   (optional)
 *  - sendgridApiKey (optional, if not provided uses config.SENDGRID_API_KEY)
 */
const sendEmail = async ({
  to,
  subject,
  text,
  html,
  fromEmail,
  fromName,
  replyTo,
  sendgridApiKey
}) => {
  try {
    const apiKey = sendgridApiKey || config.SENDGRID_API_KEY;
    if (!apiKey) {
      throw new Error("Missing SendGrid API key");
    }

    sgMail.setApiKey(apiKey);

    const msg = {
      to,
      from: {
        email: fromEmail || 'noreply@liffy.app',
        name: fromName || 'Liffy'
      },
      subject,
      text,
      html
    };

    if (replyTo) {
      msg.replyTo = replyTo;
    }

    const response = await sgMail.send(msg);

    console.log(`Email sent to ${to}`);
    return {
      success: true,
      provider: 'sendgrid',
      raw: response && response[0] ? {
        statusCode: response[0].statusCode,
        headers: response[0].headers
      } : null
    };
  } catch (error) {
    console.error('Email send error:', error);
    return {
      success: false,
      provider: 'sendgrid',
      error: error.message
    };
  }
};

module.exports = { sendEmail };
