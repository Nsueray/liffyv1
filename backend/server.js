const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const bodyParser = require('body-parser');
const db = require('./db');

// Routers
const emailTemplatesRouter = require('./routes/emailTemplates');
const campaignsRouter = require('./routes/campaigns');
const emailLogsRouter = require('./routes/emailLogs');

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
app.use(emailTemplatesRouter);
app.use(campaignsRouter);
app.use(emailLogsRouter);

// 404 fallback (JSON)
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`Liffy server running on port ${PORT}`);
});
