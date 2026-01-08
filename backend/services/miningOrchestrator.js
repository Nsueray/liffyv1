const TERMINAL_STATUSES = ["SUCCESS", "DEAD", "TERMINAL"];
const CONTINUE_STATUSES = ["PARTIAL", "BLOCKED", "ERROR"];

async function orchestrate(job, miners) {
    const startTime = Date.now();
    const logs = [];
    
    const log = (msg) => {
        const entry = `[Orchestrator] ${msg}`;
        logs.push(entry);
        console.log(entry);
    };

    log(`Starting orchestration for job ${job.id}`);
    log(`Type: ${job.type}, Input: ${job.input}`);

    const normalizedType = normalizeJobType(job.type);

    if (normalizedType === "file") {
        log("File job detected → Running File Miner ONLY");
        
        if (!miners.fileMiner) {
            log("ERROR: No fileMiner provided");
            return createFailedResult(startTime, logs, "No file miner available");
        }

        const result = await executeMiner("FileMiner", miners.fileMiner, job, log);
        result.meta.total_orchestration_time_ms = Date.now() - startTime;
        result.logs = logs;
        return result;
    }

    if (normalizedType === "url") {
        const minerSequence = [
            { name: "AxiosMiner", fn: miners.axiosMiner },
            { name: "PlaywrightMiner", fn: miners.playwrightMiner }
        ].filter(m => typeof m.fn === "function");

        if (minerSequence.length === 0) {
            log("ERROR: No URL miners provided");
            return createFailedResult(startTime, logs, "No URL miners available");
        }

        let lastResult = null;

        for (const miner of minerSequence) {
            log(`Attempting: ${miner.name}`);
            
            const result = await executeMiner(miner.name, miner.fn, job, log);
            lastResult = result;

            log(`${miner.name} returned status: ${result.status}, emails: ${result.emails.length}`);

            if (TERMINAL_STATUSES.includes(result.status)) {
                log(`${miner.name} returned ${result.status} → STOPPING`);
                result.meta.total_orchestration_time_ms = Date.now() - startTime;
                result.logs = logs;
                return result;
            }

            if (CONTINUE_STATUSES.includes(result.status)) {
                log(`${miner.name} returned ${result.status} → CONTINUING to next miner`);
                continue;
            }

            log(`${miner.name} returned unknown status: ${result.status} → CONTINUING`);
        }

        log("All miners exhausted → Returning FAILED");
        return createFailedResult(startTime, logs, "All miners failed", lastResult);
    }

    log(`Unknown job type: ${job.type} → Returning FAILED`);
    return createFailedResult(startTime, logs, `Unknown job type: ${job.type}`);
}

function normalizeJobType(type) {
    const fileTypes = ["file", "pdf", "excel", "word", "other"];
    if (fileTypes.includes(type)) {
        return "file";
    }
    if (type === "url") {
        return "url";
    }
    return "unknown";
}

async function executeMiner(minerName, minerFn, job, log) {
    const startTime = Date.now();
    
    try {
        const result = await minerFn(job);
        const executionTime = Date.now() - startTime;
        
        log(`${minerName} completed in ${executionTime}ms`);

        if (!isValidScrapeResult(result)) {
            log(`${minerName} returned invalid ScrapeResult → treating as ERROR`);
            return {
                status: "ERROR",
                emails: [],
                extracted_links: [],
                http_code: null,
                meta: {
                    miner_name: minerName,
                    execution_time_ms: executionTime,
                    notes: "Invalid ScrapeResult format"
                }
            };
        }

        result.meta = result.meta || {};
        result.meta.miner_name = minerName;
        result.meta.execution_time_ms = executionTime;

        return result;

    } catch (err) {
        const executionTime = Date.now() - startTime;
        log(`${minerName} threw error: ${err.message}`);

        const status = detectErrorStatus(err);

        return {
            status: status,
            emails: [],
            extracted_links: [],
            http_code: null,
            meta: {
                miner_name: minerName,
                execution_time_ms: executionTime,
                notes: err.message
            }
        };
    }
}

function isValidScrapeResult(result) {
    if (!result || typeof result !== "object") {
        return false;
    }
    if (typeof result.status !== "string") {
        return false;
    }
    if (!Array.isArray(result.emails)) {
        return false;
    }
    return true;
}

function detectErrorStatus(err) {
    if (!err || !err.message) {
        return "ERROR";
    }
    
    const message = err.message.toUpperCase();
    
    if (message.includes("BLOCK") || message.includes("403") || message.includes("CAPTCHA")) {
        return "BLOCKED";
    }
    
    if (message.includes("404") || message.includes("NOT FOUND") || message.includes("DEAD")) {
        return "DEAD";
    }
    
    return "ERROR";
}

function createFailedResult(startTime, logs, notes, lastResult) {
    return {
        status: "FAILED",
        emails: lastResult?.emails || [],
        extracted_links: lastResult?.extracted_links || [],
        http_code: lastResult?.http_code || null,
        meta: {
            miner_name: "Orchestrator",
            execution_time_ms: Date.now() - startTime,
            total_orchestration_time_ms: Date.now() - startTime,
            notes: notes
        },
        logs: logs
    };
}

module.exports = {
    orchestrate,
    executeMiner,
    isValidScrapeResult,
    normalizeJobType,
    TERMINAL_STATUSES,
    CONTINUE_STATUSES
};
