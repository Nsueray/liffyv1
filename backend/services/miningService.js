/**
 * Mining Service
 * Routes jobs to appropriate miners
 * 
 * - URL jobs → miningWorker (Playwright)
 * - File jobs → fileOrchestrator (new system)
 */

const { orchestrate: orchestrateMining } = require('./miningOrchestrator');
const { orchestrate: orchestrateFile } = require('./fileOrchestrator');

// Miners for URL jobs
let axiosMiner, playwrightMiner;
try {
    axiosMiner = require('./urlMiner');
} catch (e) {
    console.log('urlMiner not available');
}
try {
    const adapter = require('./playwrightMinerAdapter');
    playwrightMiner = adapter.runPlaywrightMiner || adapter.runMiningTest;
} catch (e) {
    console.log('playwrightMinerAdapter not available');
}

// File miner (legacy fallback)
let fileMiner;
try {
    fileMiner = require('./fileMiner');
} catch (e) {
    console.log('legacy fileMiner not available');
}

/**
 * Process a mining job
 * @param {Object} job - Mining job from database
 * @returns {Promise<Object>} - Mining result
 */
async function processMiningJob(job) {
    const jobType = normalizeJobType(job.type);
    
    console.log(`[MiningService] Processing job ${job.id}, type: ${jobType}`);

    // FILE JOBS → New File Orchestrator
    if (jobType === 'file') {
        console.log(`[MiningService] Routing to File Orchestrator`);
        return orchestrateFile(job);
    }

    // URL JOBS → Original Orchestrator with Playwright
    if (jobType === 'url') {
        console.log(`[MiningService] Routing to URL Mining Orchestrator`);
        return orchestrateMining(job, {
            axiosMiner: axiosMiner?.mine,
            playwrightMiner: playwrightMiner,
            fileMiner: fileMiner?.runFileMining
        });
    }

    // Unknown type
    throw new Error(`Unknown job type: ${job.type}`);
}

/**
 * Normalize job type
 */
function normalizeJobType(type) {
    const fileTypes = ['file', 'pdf', 'excel', 'word', 'csv', 'other'];
    if (fileTypes.includes(type)) return 'file';
    if (type === 'url') return 'url';
    return 'unknown';
}

module.exports = {
    processMiningJob,
    normalizeJobType,
};
