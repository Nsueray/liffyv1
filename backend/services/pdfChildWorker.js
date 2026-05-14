/**
 * pdfChildWorker.js — Isolated child process for PDF mining
 *
 * Runs fileMiner.processFile() in a separate process with memory limits.
 * If PDF processing exceeds the memory limit, only this process dies —
 * the main worker stays alive.
 *
 * Usage: Spawned by pdfProcessGuard.js via child_process.fork()
 *
 * IPC protocol:
 *   Parent sends: { tempPath: string, filename: string }
 *   Child replies: { success: true, result: object } or { success: false, error: string }
 */

const fs = require('fs');
const path = require('path');

// Require fileMiner in child process (cold start, re-imports pdf-parse etc.)
const fileMiner = require('./fileMiner');

process.on('message', async (msg) => {
    const { tempPath, filename } = msg;

    try {
        console.log(`[PDFChild] Processing: ${filename} from ${tempPath}`);
        const buffer = await fs.promises.readFile(tempPath);
        console.log(`[PDFChild] Buffer size: ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);

        const result = await fileMiner.processFile(buffer, filename);

        // Send result back — strip buffer data, keep only serializable fields
        process.send({
            success: true,
            result: {
                contacts: result.contacts || [],
                stats: result.stats || {},
            },
        });
    } catch (err) {
        console.error(`[PDFChild] Error: ${err.message}`);
        process.send({
            success: false,
            error: err.message,
        });
    }

    // Exit cleanly after processing
    process.exit(0);
});

// Safety: exit if no message received within 5 minutes
setTimeout(() => {
    console.error('[PDFChild] Timeout — no message received in 5 minutes');
    process.exit(1);
}, 5 * 60 * 1000);
