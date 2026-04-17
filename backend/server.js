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
const actionsRouter = require('./routes/actions');
const timelineRouter = require('./routes/timeline');
const contextRouter = require('./routes/context');
const waitingRouter = require('./routes/waiting');

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

// TEMPORARY DEBUG — remove after production diagnosis
app.get('/api/debug-scope', async (req, res) => {
  try {
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'liffy_secret_key_change_me';
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No auth header' });
    const token = authHeader.replace('Bearer ', '').trim();
    const payload = jwt.verify(token, JWT_SECRET);

    // What the JWT says
    const jwtInfo = {
      user_id: payload.user_id,
      organizer_id: payload.organizer_id,
      role: payload.role,
      email: payload.email,
      iat: new Date(payload.iat * 1000).toISOString(),
      exp: new Date(payload.exp * 1000).toISOString(),
    };

    // What the DB says
    const userRes = await db.query(
      `SELECT id, email, role, reports_to, organizer_id FROM users WHERE id = $1`,
      [payload.user_id]
    );
    const dbUser = userRes.rows[0] || null;

    // Recursive CTE test
    const teamRes = await db.query(
      `WITH RECURSIVE my_team AS (
         SELECT id, email, role FROM users WHERE id = $1
         UNION ALL
         SELECT u.id, u.email, u.role FROM users u JOIN my_team t ON u.reports_to = t.id
       )
       SELECT id, email, role FROM my_team`,
      [payload.user_id]
    );

    // getUserContext simulation
    const { getUserContext, isPrivileged, getHierarchicalScope } = require('./middleware/userScope');
    const fakeReq = { auth: { user_id: payload.user_id, organizer_id: payload.organizer_id, role: payload.role } };
    const ctx = getUserContext(fakeReq);
    const scope = getHierarchicalScope(fakeReq, 'test_col', 1);

    // Quick campaign count test
    const campRes = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM campaigns
       WHERE organizer_id = $1 AND created_by_user_id IN (
         WITH RECURSIVE my_team AS (
           SELECT id FROM users WHERE id = $2
           UNION ALL
           SELECT u.id FROM users u JOIN my_team t ON u.reports_to = t.id
         )
         SELECT id FROM my_team
       )`,
      [payload.organizer_id, payload.user_id]
    );

    res.json({
      jwt: jwtInfo,
      db_user: dbUser,
      recursive_team: teamRes.rows,
      getUserContext: ctx,
      isPrivileged: isPrivileged(fakeReq),
      scope_sql_preview: scope.sql.substring(0, 200),
      scope_params: scope.params,
      campaign_count_via_cte: campRes.rows[0].cnt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
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
app.use('/api/actions', actionsRouter);
app.use('/api/timeline', timelineRouter);
app.use('/api/context', contextRouter);
app.use('/api/waiting', waitingRouter);
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

// Action Engine worker — reconciles triggers every 15 min
if (!process.env.DISABLE_ACTION_WORKER) {
  const actionWorker = require('./engines/action-engine/actionWorker');
  actionWorker.start();
  process.on('SIGTERM', () => actionWorker.stop());
}
