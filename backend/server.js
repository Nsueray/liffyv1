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
    res.json({ status: 'ok', version: '1ac470a-diag' });
  } catch (error) {
    res.status(503).json({ status: 'error', message: error.message });
  }
});

// TEMPORARY diagnostic — remove after fix
app.get('/api/diag/counts', async (req, res) => {
  try {
    const orgId = '63b52d61-ae2c-4dad-b429-48151b1b16d6';
    const [tpl, snd] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS cnt, COUNT(*) FILTER (WHERE visibility = 'shared')::int AS shared_cnt, COUNT(*) FILTER (WHERE visibility IS NULL)::int AS null_cnt FROM email_templates WHERE organizer_id = $1`, [orgId]),
      db.query(`SELECT COUNT(*)::int AS cnt, COUNT(*) FILTER (WHERE visibility = 'shared')::int AS shared_cnt, COUNT(*) FILTER (WHERE visibility IS NULL)::int AS null_cnt FROM sender_identities WHERE organizer_id = $1 AND is_active = true`, [orgId]),
    ]);

    // Simulate what route does for Suer (owner)
    const { isPrivileged, getUpwardVisibilityScope } = require('./middleware/userScope');
    const fakeReq = { auth: { user_id: 'cfb66f28-54b1-4a82-85d5-616bb6bbd40b', organizer_id: orgId, role: 'owner' } };
    const priv = isPrivileged(fakeReq);
    const tplScope = getUpwardVisibilityScope(fakeReq, 'created_by_user_id', 'visibility', 2);
    const sndScope = getUpwardVisibilityScope(fakeReq, 'user_id', 'visibility', 2);

    const tplRoute = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM email_templates WHERE organizer_id = $1 ${tplScope.sql}`,
      [orgId, ...tplScope.params]
    );
    const sndRoute = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM sender_identities WHERE organizer_id = $1 AND is_active = true ${sndScope.sql}`,
      [orgId, ...sndScope.params]
    );

    // If JWT is provided, also decode it and simulate with THAT user's context
    let jwtDiag = null;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const jwt = require('jsonwebtoken');
        const JWT_SECRET = process.env.JWT_SECRET || 'liffy_secret_key_change_me';
        const token = authHeader.replace('Bearer ', '').trim();
        const payload = jwt.verify(token, JWT_SECRET);
        payload.user_id = payload.user_id || payload.id; // normalize

        const jwtReq = { auth: { user_id: payload.user_id, organizer_id: payload.organizer_id, role: payload.role } };
        const jwtPriv = isPrivileged(jwtReq);
        const jwtTplScope = getUpwardVisibilityScope(jwtReq, 'created_by_user_id', 'visibility', 2);
        const jwtSndScope = getUpwardVisibilityScope(jwtReq, 'user_id', 'visibility', 2);

        const jwtTpl = await db.query(
          `SELECT COUNT(*)::int AS cnt FROM email_templates WHERE organizer_id = $1 ${jwtTplScope.sql}`,
          [payload.organizer_id, ...jwtTplScope.params]
        );
        const jwtSnd = await db.query(
          `SELECT COUNT(*)::int AS cnt FROM sender_identities WHERE organizer_id = $1 AND is_active = true ${jwtSndScope.sql}`,
          [payload.organizer_id, ...jwtSndScope.params]
        );

        jwtDiag = {
          payload: { user_id: payload.user_id, organizer_id: payload.organizer_id, role: payload.role, email: payload.email },
          isPrivileged: jwtPriv,
          tpl_scope_empty: jwtTplScope.sql === '',
          snd_scope_empty: jwtSndScope.sql === '',
          templates: jwtTpl.rows[0].cnt,
          senders: jwtSnd.rows[0].cnt,
        };
      } catch (e) {
        jwtDiag = { error: e.message };
      }
    }

    res.json({
      db: { templates: tpl.rows[0], senders: snd.rows[0] },
      suer_privileged: priv,
      suer_tpl_scope_empty: tplScope.sql === '',
      suer_snd_scope_empty: sndScope.sql === '',
      route_sim: { templates: tplRoute.rows[0].cnt, senders: sndRoute.rows[0].cnt },
      jwt_diag: jwtDiag,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
