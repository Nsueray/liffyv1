const { orchestrate } = require("./miningOrchestrator");
const { runFileMining } = require("./fileMiner");
const { runUrlMiningJob } = require("./urlMiner");
const { runMiningTest } = require("./miningWorker");
const db = require("../db");

async function fileMinerAdapter(job) {
    const startTime = Date.now();
    
    try {
        await runFileMining(job);
        
        const dbResult = await db.query(
            `SELECT 
                mr.emails,
                mr.company_name,
                mr.phone
             FROM mining_results mr
             WHERE mr.job_id = $1`,
            [job.id]
        );
        
        const emails = [];
        for (const row of dbResult.rows) {
            if (Array.isArray(row.emails)) {
                emails.push(...row.emails);
            }
        }
        
        const uniqueEmails = [...new Set(emails)];
        
        return {
            status: "TERMINAL",
            emails: uniqueEmails,
            extracted_links: [],
            http_code: null,
            meta: {
                miner_name: "FileMiner",
                execution_time_ms: Date.now() - startTime,
                notes: `Extracted ${uniqueEmails.length} emails from file`
            }
        };
        
    } catch (err) {
        return {
            status: "TERMINAL",
            emails: [],
            extracted_links: [],
            http_code: null,
            meta: {
                miner_name: "FileMiner",
                execution_time_ms: Date.now() - startTime,
                notes: `Error: ${err.message}`
            }
        };
    }
}

async function axiosMinerAdapter(job) {
    const startTime = Date.now();
    
    try {
        const result = await runUrlMiningJob(job.id, job.organizer_id);
        
        let emails = [];
        let extractedLinks = [];
        let httpCode = null;
        let notes = null;
        
        if (result) {
            if (Array.isArray(result.emails)) {
                emails = result.emails;
            }
            
            if (result.stats) {
                if (Array.isArray(result.stats.detail_urls_considered)) {
                    extractedLinks = result.stats.detail_urls_considered;
                }
                if (typeof result.stats.emails_raw === "number") {
                    notes = `Legacy: ${result.stats.emails_raw} raw emails reported`;
                }
            }
            
            if (typeof result.total_emails_raw === "number" && result.total_emails_raw > 0 && emails.length === 0) {
                const dbResult = await db.query(
                    `SELECT p.email 
                     FROM prospects p
                     JOIN list_members lm ON lm.prospect_id = p.id
                     WHERE lm.list_id = $1`,
                    [result.list_id]
                );
                emails = dbResult.rows.map(r => r.email).filter(Boolean);
            }
            
            httpCode = result.http_code || null;
            
            if (result.error) {
                notes = result.error;
            }
        }
        
        return {
            status: result?.status || "UNKNOWN",
            emails: emails,
            extracted_links: extractedLinks,
            http_code: httpCode,
            meta: {
                miner_name: "AxiosMiner",
                execution_time_ms: Date.now() - startTime,
                notes: notes
            }
        };
        
    } catch (err) {
        return {
            status: "UNKNOWN",
            emails: [],
            extracted_links: [],
            http_code: null,
            meta: {
                miner_name: "AxiosMiner",
                execution_time_ms: Date.now() - startTime,
                notes: `Error: ${err.message}`
            }
        };
    }
}

async function playwrightMinerAdapter(job) {
    const startTime = Date.now();

    // 🔒 HARD GUARD: Playwright is NOT allowed on Render
    if (process.env.RENDER || process.env.RENDER_SERVICE_ID) {
        return {
            status: "BLOCKED",
            emails: [],
            extracted_links: [],
            http_code: null,
            meta: {
                miner_name: "PlaywrightMiner",
                execution_time_ms: 0,
                notes: "PLAYWRIGHT_DISABLED_ON_RENDER"
            }
        };
    }
    
    try {
        const playwrightJob = { ...job, strategy: "playwright" };
        
        const result = await runMiningTest(playwrightJob);
        
        const dbResult = await db.query(
            `SELECT 
                mr.emails,
                mr.source_url
             FROM mining_results mr
             WHERE mr.job_id = $1`,
            [job.id]
        );
        
        const emails = [];
        const links = [];
        
        for (const row of dbResult.rows) {
            if (Array.isArray(row.emails)) {
                emails.push(...row.emails);
            }
            if (row.source_url) {
                links.push(row.source_url);
            }
        }
        
        const uniqueEmails = [...new Set(emails)];
        const uniqueLinks = [...new Set(links)];
        
        return {
            status: result?.status || "UNKNOWN",
            emails: uniqueEmails,
            extracted_links: uniqueLinks,
            http_code: result?.http_code || null,
            meta: {
                miner_name: "PlaywrightMiner",
                execution_time_ms: Date.now() - startTime,
                notes: `Queried DB: found ${uniqueEmails.length} emails`
            }
        };
        
    } catch (err) {
        const message = err.message || "";

        const isPlaywrightMissing =
            message.includes("Executable doesn't exist") ||
            message.includes("playwright install") ||
            message.includes("browserType.launch");

        return {
            status: isPlaywrightMissing ? "BLOCKED" : "UNKNOWN",
            emails: [],
            extracted_links: [],
            http_code: null,
            meta: {
                miner_name: "PlaywrightMiner",
                execution_time_ms: Date.now() - startTime,
                notes: isPlaywrightMissing
                    ? "PLAYWRIGHT_NOT_AVAILABLE"
                    : `Error: ${message}`
            }
        };
    }
}

async function processMiningJob(job) {
    const miners = {
        fileMiner: fileMinerAdapter,
        axiosMiner: axiosMinerAdapter,
        playwrightMiner: playwrightMinerAdapter
    };
    
    const result = await orchestrate(job, miners);
    
    return result;
}

module.exports = {
    processMiningJob,
    fileMinerAdapter,
    axiosMinerAdapter,
    playwrightMinerAdapter
};
