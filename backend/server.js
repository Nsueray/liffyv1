console.log('[Startup] Heap limit:', require('v8').getHeapStatistics().heap_size_limit / 1024 / 1024, 'MB');

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
const settingsRouter = require('./routes/settings');
const webhooksRouter = require('./routes/webhooks');
const statsRouter = require('./routes/stats');
const verificationRouter = require('./routes/verification');
const zohoRouter = require('./routes/zoho');
const personsRouter = require('./routes/persons');
const intentsRouter = require('./routes/intents');
const unsubscribesRouter = require('./routes/unsubscribes');
const adminAIMinerRouter = require('./routes/adminAIMiner');
const sourceDiscoveryRouter = require('./routes/sourceDiscovery');
const contactCrmRouter = require('./routes/contactCrm');
const pipelineRouter = require('./routes/pipeline');
const userManagementRouter = require('./routes/userManagement');
const sequencesRouter = require('./routes/sequences');

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
app.use('/api/settings', settingsRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/verification', verificationRouter);
app.use('/api/zoho', zohoRouter);
// Contact CRM routes must come BEFORE /api/persons router so that
// /api/persons/:id/notes|activities|tasks are matched by contactCrm first.
app.use(contactCrmRouter);
// Pipeline router hosts both /api/pipeline/* and PATCH /api/persons/:id/stage.
// Mount before /api/persons router so the stage endpoint is matched first.
app.use(pipelineRouter);
app.use('/api/persons', personsRouter);
app.use('/api/intents', intentsRouter);
app.use('/api/unsubscribes', unsubscribesRouter);
app.use('/api/admin/ai-miner', adminAIMinerRouter);
app.use('/api/source-discovery', sourceDiscoveryRouter);
app.use('/api/users', userManagementRouter);
app.use(sequencesRouter);
app.use(webhooksRouter);
app.use(statsRouter);

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

// Sequence worker — polls and sends multi-touch sequence emails
if (!process.env.DISABLE_SEQUENCE_WORKER) {
  const sequenceWorker = require('./services/sequenceWorker');
  sequenceWorker.start();
  process.on('SIGTERM', () => sequenceWorker.stop());
}
