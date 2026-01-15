const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const bodyParser = require('body-parser');
const db = require('./db');

// Routers
const emailTemplatesRouter = require('./routes/emailTemplates');
const campaignsRouter = require('./routes/campaigns');
const emailLogsRouter = require('./routes/emailLogs');
const testEmailRouter = require('./routes/testEmail');
const authRouter = require('./routes/auth');
const sendersRouter = require('./routes/senders');
const campaignRecipientsRouter = require('./routes/campaignRecipients');
const campaignSendRouter = require('./routes/campaignSend');
const reportsRouter = require('./routes/reports');
const prospectsRouter = require('./routes/prospects');
const miningJobsRouter = require('./routes/miningJobs');
const miningResultsRouter = require('./routes/miningResults');
const leadsRouter = require('./routes/leads');
const listsRouter = require('./routes/lists');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const client = await db.connect();
    await client.query('SELECT 1');
    client.release();
    res.json({ status: 'ok' });
  } catch (error) {
    res.status(503).json({ status: 'error', message: error.message });
  }
});

// API routes
app.use('/api/email-templates', emailTemplatesRouter);
app.use(campaignsRouter);
app.use(emailLogsRouter);
app.use(testEmailRouter);
app.use(authRouter);
app.use(sendersRouter);
app.use(campaignRecipientsRouter);
app.use(campaignSendRouter);
app.use(reportsRouter);
app.use(prospectsRouter);
app.use(miningJobsRouter);
app.use(miningResultsRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/lists', listsRouter);
app.use('/api/campaigns', campaignsRouter);

// 404 fallback (JSON)
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`Liffy server running on port ${PORT}`);
});

const { runMiningTest } = require('./services/miningWorker');

if (process.env.MINING_TEST === "1") {
  runMiningTest();
}
