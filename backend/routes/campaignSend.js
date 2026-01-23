const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');
const { sendEmail } = require('../mailer');
const { getUnsubscribeUrl } = require('./webhooks');

const JWT_SECRET = process.env.JWT_SECRET || "liffy_secret_key_change_me";

// Auth Middleware
function authRequired(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "Missing Authorization header" });
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const payload = jwt.verify(token, JWT_SECRET);

    req.auth = {
      user_id: payload.user_id,
      organizer_id: payload.organizer_id,
      role: payload.role
    };
    next();
  } catch (err) {
    console.error("Auth error:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}



/**
 * Helper: Şablon Değişkeni Değiştirici
 * 
 * Desteklenen Placeholder'lar:
 * {{first_name}}   -> İlk isim
 * {{last_name}}    -> Soyisim  
 * {{company_name}} -> Şirket adı
 * {{email}}        -> Email adresi
 * {{country}}      -> Ülke
 * {{position}}     -> Pozisyon/Ünvan
 * {{website}}      -> Website
 * {{tag}}          -> Tag (sektör vb.)
 * {{unsubscribe_url}} -> Unsubscribe link
 */
function processTemplate(text, recipient, extras = {}) {
  if (!text) return "";
  
  // Recipient verilerini hazırla
  const fullName = recipient.name || "";
  const nameParts = fullName.trim().split(/\s+/);
  const firstName = nameParts[0] || "";
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : "";
  
  // Meta verisi JSONB olduğu için obje olarak gelebilir
  let meta = {};
  if (recipient.meta) {
    try {
      meta = typeof recipient.meta === 'string' 
        ? JSON.parse(recipient.meta) 
        : recipient.meta;
    } catch (e) {
      meta = {};
    }
  }
  
  // Değerleri hazırla (hepsi güvenli, null ise boş string)
  const companyName = meta.company || meta.company_name || "";
  const country = meta.country || "";
  const position = meta.position || meta.job_title || meta.title || "";
  const website = meta.website || "";
  const tag = Array.isArray(meta.tags) ? (meta.tags[0] || "") : (meta.tag || "");
  const email = recipient.email || "";

  // Değiştirme işlemi (Case insensitive)
  let processed = text;
  
  // İsim placeholder'ları
  processed = processed.replace(/{{first_name}}/gi, firstName);
  processed = processed.replace(/{{last_name}}/gi, lastName);
  processed = processed.replace(/{{name}}/gi, fullName); // Geriye uyumluluk
  
  // Şirket
  processed = processed.replace(/{{company_name}}/gi, companyName);
  processed = processed.replace(/{{company}}/gi, companyName); // Geriye uyumluluk
  
  // Diğer alanlar
  processed = processed.replace(/{{email}}/gi, email);
  processed = processed.replace(/{{country}}/gi, country);
  processed = processed.replace(/{{position}}/gi, position);
  processed = processed.replace(/{{website}}/gi, website);
  processed = processed.replace(/{{tag}}/gi, tag);

  // Unsubscribe
  if (extras.unsubscribe_url) {
    processed = processed.replace(/{{unsubscribe_url}}/gi, extras.unsubscribe_url);
    processed = processed.replace(/{{unsubscribe_link}}/gi, extras.unsubscribe_url);
  }

  return processed;
}

// POST /api/campaigns/:id/send-batch
// Bu endpoint Worker veya Frontend tarafından periyodik çağrılır
router.post('/api/campaigns/:id/send-batch', authRequired, async (req, res) => {
  const client = await db.connect();

  try {
    const campaign_id = req.params.id;
    const organizer_id = req.auth.organizer_id;
    const { batch_size } = req.body; // Örn: 10 mail gönder

    const limit = parseInt(batch_size, 10) || 5; // Varsayılan 5 (Güvenli başlangıç)

    // 1. Kampanya ve Template Bilgisini Çek
    const campRes = await client.query(
      `SELECT c.*, t.subject, t.body_html, t.body_text
       FROM campaigns c
       JOIN email_templates t ON c.template_id = t.id
       WHERE c.id = $1 AND c.organizer_id = $2`,
      [campaign_id, organizer_id]
    );

    if (campRes.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const campaign = campRes.rows[0];

    // Durum Kontrolleri
    if (campaign.status === 'paused') {
      return res.json({ success: true, message: "Campaign paused", sent: 0, paused: true });
    }
    
    if (campaign.status !== 'sending') {
       // Eğer 'ready' ise ve kullanıcı start dediyse 'sending'e çekmek için ayrı bir endpoint var.
       // Bu endpoint sadece 'sending' durumundakileri işler.
      return res.status(400).json({
        error: `Cannot send: campaign status is '${campaign.status}', expected 'sending'`
      });
    }

    if (!campaign.sender_id) {
      return res.status(400).json({ error: "Campaign has no sender_id" });
    }

    // 2. Organizer Ayarlarını (API Key) Çek
    const orgRes = await client.query(
      `SELECT sendgrid_api_key FROM organizers WHERE id = $1`,
      [organizer_id]
    );
    const organizer = orgRes.rows[0];

    if (!organizer || !organizer.sendgrid_api_key) {
        return res.status(400).json({ error: "Organizer SendGrid API Key not found in Settings" });
    }

    // 3. Gönderici Kimliğini Çek
    const senderRes = await client.query(
      `SELECT * FROM sender_identities
       WHERE id = $1 AND organizer_id = $2 AND is_active = true`,
      [campaign.sender_id, organizer_id]
    );

    if (senderRes.rows.length === 0) {
      return res.status(400).json({ error: "Sender identity inactive or missing" });
    }
    const sender = senderRes.rows[0];

    // 4. Gönderilecek Kişileri (Pending) Çek
    // FOR UPDATE SKIP LOCKED: Aynı anda birden fazla worker çalışırsa çakışmayı önler
    const recRes = await client.query(
      `SELECT * FROM campaign_recipients
       WHERE campaign_id = $1 AND organizer_id = $2 AND status = 'pending'
       ORDER BY id ASC
       LIMIT $3
       FOR UPDATE SKIP LOCKED`, 
      [campaign_id, organizer_id, limit]
    );

    const recipients = recRes.rows;

    // Eğer gönderilecek kimse kalmadıysa
    if (recipients.length === 0) {
      // Bekleyen var mı diye son bir kontrol (Locklanmış olabilir mi?)
      const pendingCheck = await client.query(
        `SELECT COUNT(*) as count FROM campaign_recipients
         WHERE campaign_id = $1 AND organizer_id = $2 AND status = 'pending'`,
        [campaign_id, organizer_id]
      );

      const pendingCount = parseInt(pendingCheck.rows[0].count, 10) || 0;

      if (pendingCount === 0) {
        // Hepsi bitmiş, kampanyayı tamamla
        await client.query(
          `UPDATE campaigns SET status = 'completed', completed_at = NOW() 
           WHERE id = $1 AND organizer_id = $2`,
          [campaign_id, organizer_id]
        );
        return res.json({ success: true, message: "Campaign Completed", completed: true });
      }

      return res.json({ success: true, message: "No available recipients right now (maybe locked)", sent: 0 });
    }

    // 5. Gönderim Döngüsü
    let sentCount = 0;
    let failCount = 0;

    for (const r of recipients) {
        // DEBUG: Log recipient data
        console.log("[CampaignSend] Recipient:", r.email, "Name:", r.name, "Meta:", JSON.stringify(r.meta));
      try {
        // Generate unsubscribe URL for this recipient
        const unsubscribe_url = getUnsubscribeUrl(r.email, organizer_id);

        // A. Kişiselleştirme (Variable Replacement)
        const personalizedSubject = processTemplate(campaign.subject, r);
        const personalizedHtml = processTemplate(campaign.body_html, r, { unsubscribe_url });
        const personalizedText = processTemplate(campaign.body_text || "", r, { unsubscribe_url });

        // B. Gönderim (Mailer'a Dinamik Key Gönderiyoruz)
        const mailResp = await sendEmail({
          to: r.email,
          subject: personalizedSubject,
          text: personalizedText,
          html: personalizedHtml,
          from_name: sender.from_name,
          from_email: sender.from_email,
          reply_to: sender.reply_to || null,
          sendgrid_api_key: organizer.sendgrid_api_key // ÖNEMLİ: Settings'den gelen key
        });

        // C. Sonucu İşle
        if (mailResp && mailResp.success) {
          sentCount++;
          // Başarılı
          await client.query(
            `UPDATE campaign_recipients SET status = 'sent', sent_at = NOW(), last_error = NULL WHERE id = $1`,
            [r.id]
          );
          
          // Logla
          await client.query(
            `INSERT INTO email_logs
             (organizer_id, campaign_id, template_id, recipient_email, recipient_data, status, provider_response, sent_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
            [organizer_id, campaign_id, campaign.template_id, r.email, r.meta, 'sent', mailResp]
          );

        } else {
          failCount++;
          // Başarısız (SMTP Hatası vb.)
          const errorMsg = mailResp && mailResp.error ? JSON.stringify(mailResp.error) : 'Unknown Error';
          await client.query(
            `UPDATE campaign_recipients SET status = 'failed', last_error = $2 WHERE id = $1`,
            [r.id, errorMsg]
          );
        }

      } catch (e) {
        failCount++;
        console.error(`Send error for ${r.email}:`, e.message);
        await client.query(
          `UPDATE campaign_recipients SET status = 'failed', last_error = $2 WHERE id = $1`,
          [r.id, e.message]
        );
      }
    }

    return res.json({
      success: true,
      message: "Batch processed",
      total: recipients.length,
      sent: sentCount,
      failed: failCount
    });

  } catch (err) {
    console.error("send-batch fatal error:", err);
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
