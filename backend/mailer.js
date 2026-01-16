const sgMail = require('@sendgrid/mail');
const config = require('./config');

/**
 * Strips HTML tags and returns plain text
 */
function htmlToPlainText(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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
  from_email,
  from_name,
  replyTo,
  reply_to,
  sendgrid_api_key,
  sendgridApiKey
}) => {
  try {
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

    // Prepare content - SendGrid requires at least 1 character
    let finalHtml = html && html.trim() ? html.trim() : null;
    let finalText = text && text.trim() ? text.trim() : null;

    // If no text but html exists, generate text from html
    if (!finalText && finalHtml) {
      finalText = htmlToPlainText(finalHtml);
    }

    // If still no text, use a space (SendGrid minimum requirement)
    if (!finalText) {
      finalText = ' ';
    }

    // If no html but text exists, use text as html
    if (!finalHtml && finalText) {
      finalHtml = finalText.replace(/\n/g, '<br>');
    }

    const msg = {
      to,
      from: {
        email: senderEmail,
        name: senderName
      },
      subject: subject || '(No Subject)',
      text: finalText,
      html: finalHtml
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
