const { spawn } = require('child_process');
const path = require('path');

/**
 * Adapter for starting Playwright mining jobs
 * Runs as trusted internal process (NO API TOKEN)
 */
class PlaywrightMinerAdapter {
  constructor(db) {
    this.db = db;
  }

  async startJob(jobId) {
    const client = await this.db.connect();
    try {
      const res = await client.query(
        'SELECT id, strategy, status FROM mining_jobs WHERE id = $1',
        [jobId]
      );

      if (res.rows.length === 0) {
        throw new Error(`Mining job not found: ${jobId}`);
      }

      const job = res.rows[0];

      if (!['playwright', 'auto'].includes(job.strategy)) {
        throw new Error(`Job ${jobId} is not a playwright job`);
      }

      if (job.status === 'running') {
        return;
      }
    } finally {
      client.release();
    }

    const workerPath = path.join(__dirname, 'miningWorker.js');

    const env = {
      ...process.env,
      MINING_JOB_ID: jobId,
    };

    const child = spawn('node', [workerPath], {
      env,
      detached: true,
      stdio: 'ignore',
    });

    child.unref();

    await this.db.query(
      'UPDATE mining_jobs SET status = $1 WHERE id = $2',
      ['queued', jobId]
    );

    console.log(`Started Playwright mining worker for job ${jobId}`);
  }
}

module.exports = {
  PlaywrightMinerAdapter,
};
