/**
 * pdfProcessGuard.js — Memory-safe PDF processing via child process isolation
 *
 * Forks a child process with --max-old-space-size to run fileMiner.processFile().
 * If the PDF causes an OOM, only the child process dies. The main worker/API
 * process stays alive and marks the job as failed.
 *
 * @version 1.0.0
 */

const { fork } = require('child_process');
const path = require('path');

const CHILD_WORKER_PATH = path.join(__dirname, 'pdfChildWorker.js');

// Memory limit for child process (MB). Leave headroom for the main process.
const CHILD_MEMORY_LIMIT_MB = 1536; // 1.5GB — fits within 2GB Standard tier

// Timeout for the entire child process (ms)
const CHILD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Process a PDF file in an isolated child process with memory limits.
 *
 * @param {string} tempPath — Path to the PDF file on disk
 * @param {string} filename — Original filename (for fileMiner detection)
 * @returns {Promise<object>} — fileMiner.processFile result ({ contacts, stats })
 */
function processFileIsolated(tempPath, filename) {
    return new Promise((resolve, reject) => {
        const child = fork(CHILD_WORKER_PATH, [], {
            execArgv: [`--max-old-space-size=${CHILD_MEMORY_LIMIT_MB}`],
            stdio: ['pipe', 'inherit', 'inherit', 'ipc'], // inherit stdout/stderr for logs
        });

        let settled = false;

        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                child.kill('SIGKILL');
                reject(new Error(`PDF processing timed out after ${CHILD_TIMEOUT_MS / 1000}s`));
            }
        }, CHILD_TIMEOUT_MS);

        child.on('message', (msg) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);

            if (msg.success) {
                resolve(msg.result);
            } else {
                reject(new Error(`PDF child process error: ${msg.error}`));
            }
        });

        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(new Error(`PDF child process spawn error: ${err.message}`));
        });

        child.on('exit', (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);

            if (signal === 'SIGKILL' || signal === 'SIGSEGV' || code === 139 || code === 137) {
                reject(new Error(
                    `PDF processing killed (signal=${signal}, code=${code}) — likely out of memory. ` +
                    `This PDF may be too complex to process. Try a smaller file or different format.`
                ));
            } else {
                reject(new Error(`PDF child process exited unexpectedly (code=${code}, signal=${signal})`));
            }
        });

        // Send the work to the child
        child.send({ tempPath, filename });
    });
}

module.exports = { processFileIsolated };
