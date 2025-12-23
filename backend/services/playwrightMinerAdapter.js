const { spawn } = require('child_process');
const path = require('path');

function runPlaywrightMiningJob(jobId) {
  return new Promise((resolve, reject) => {
    if (!jobId) {
      reject(new Error('Missing jobId for Playwright mining job'));
      return;
    }

    if (!process.env.MINING_API_TOKEN) {
      reject(new Error('MINING_API_TOKEN is required for Playwright mining jobs'));
      return;
    }

    const runnerPath = path.join(__dirname, 'playwrightMinerRunner.js');
    const child = spawn(process.execPath, [runnerPath], {
      env: {
        ...process.env,
        MINING_JOB_ID: jobId,
      },
      stdio: 'inherit',
    });

    let settled = false;
    const handleFailure = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const handleSuccess = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    child.on('error', (err) => {
      handleFailure(err);
    });

    child.on('exit', (code) => {
      if (code === 0) {
        handleSuccess();
      } else {
        handleFailure(new Error(`Playwright miner exited with code ${code}`));
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        handleSuccess();
      } else {
        handleFailure(new Error(`Playwright miner closed with code ${code}`));
      }
    });
  });
}

module.exports = { runPlaywrightMiningJob };
