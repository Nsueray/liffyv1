const { runMiningTest } = require('./miningWorker');

const jobId = process.env.MINING_JOB_ID || null;
const apiBase = process.env.MINING_API_BASE || 'https://api.liffy.app/api';
const hasToken = Boolean(process.env.MINING_API_TOKEN);

console.log(`[PlaywrightRunner] job=${jobId} api=${apiBase} token=${hasToken}`);

runMiningTest()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('Playwright miner failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
