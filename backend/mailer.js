const sgMail = require('@sendgrid/mail');
const config = require('./config');

sgMail.setApiKey(config.SENDGRID_API_KEY);

const sendEmail = async ({ to, subject, text, html }) => {
  try {
    const msg = {
      to,
      from: 'noreply@liffy.app',
      subject,
      text,
      html
    };
    
    await sgMail.send(msg);
    console.log(`Email sent to ${to}`);
    return { success: true };
  } catch (error) {
    console.error('Email send error:', error);
    return { success: false, error: error.message };
  }
};

module.exports = { sendEmail };
