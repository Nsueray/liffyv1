/**
 * URL Miners Index
 * Central export for all URL mining modules
 * 
 * Mining Strategy:
 * All miners are run in parallel/sequence, results are merged
 * Each miner returns ScrapeResult format:
 * {
 *   status: 'SUCCESS' | 'PARTIAL' | 'ERROR' | 'BLOCKED',
 *   emails: string[],
 *   contacts: Contact[],
 *   extracted_links: string[],
 *   http_code: number,
 *   meta: object
 * }
 */

const playwrightTableMiner = require('./playwrightTableMiner');
const cloudflareDecoder = require('./cloudflareDecoder');
const resultMerger = require('./resultMerger');

module.exports = {
    // Miners
    playwrightTableMiner,
    
    // Utilities
    cloudflareDecoder,
    resultMerger,
    
    // Convenience: List of all miners for orchestration
    getAllMiners: () => [
        { name: 'PlaywrightTableMiner', mine: playwrightTableMiner.mine }
    ]
};
