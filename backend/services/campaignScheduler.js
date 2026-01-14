const db = require('../db');

async function processScheduledCampaigns() {
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(`
      SELECT id, organizer_id, name, scheduled_at
      FROM campaigns
      WHERE status = 'scheduled'
        AND scheduled_at <= NOW()
      FOR UPDATE SKIP LOCKED
    `);

    const campaigns = result.rows;

    if (campaigns.length === 0) {
      await client.query('COMMIT');
      return { processed: 0, campaigns: [] };
    }

    const processedCampaigns = [];

    for (const campaign of campaigns) {
      try {
        const updateRes = await client.query(`
          UPDATE campaigns
          SET status = 'sending'
          WHERE id = $1 
            AND organizer_id = $2 
            AND status = 'scheduled'
          RETURNING id, name
        `, [campaign.id, campaign.organizer_id]);

        if (updateRes.rows.length > 0) {
          processedCampaigns.push({
            id: campaign.id,
            name: campaign.name
          });
          console.log(`Campaign "${campaign.name}" (${campaign.id}) transitioned to sending`);
        }
      } catch (err) {
        console.error(`Failed to transition campaign ${campaign.id}:`, err.message);
      }
    }

    await client.query('COMMIT');

    return {
      processed: processedCampaigns.length,
      campaigns: processedCampaigns
    };

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Campaign scheduler error:', err);
    throw err;
  } finally {
    client.release();
  }
}

async function runScheduler() {
  try {
    const result = await processScheduledCampaigns();
    if (result.processed > 0) {
      console.log(`Campaign scheduler: Activated ${result.processed} campaign(s)`);
    }
    return result;
  } catch (err) {
    console.error('Campaign scheduler run failed:', err.message);
    return { processed: 0, campaigns: [], error: err.message };
  }
}

module.exports = {
  processScheduledCampaigns,
  runScheduler
};
