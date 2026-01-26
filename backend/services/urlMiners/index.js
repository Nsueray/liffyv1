/**
 * URL Miners Index
 * Central export for all URL mining modules
 * 
 * Available Miners:
 * - playwrightTableMiner: Single page tables/lists
 * - aiMiner: Claude AI powered extraction (best quality)
 * - documentMiner: Document viewer platforms (FlipHTML5, Issuu, etc.)
 */

const playwrightTableMiner = require('./playwrightTableMiner');
const cloudflareDecoder = require('./cloudflareDecoder');
const resultMerger = require('./resultMerger');

// AI Miner (requires ANTHROPIC_API_KEY)
let aiMiner = null;
try {
    aiMiner = require('./aiMiner');
    console.log('[urlMiners] ✅ AIMiner loaded');
} catch (e) {
    console.log('[urlMiners] ⚠️ AIMiner not available:', e.message);
}

// Document Miner (for flipbook platforms)
let documentMiner = null;
try {
    documentMiner = require('./documentMiner');
    console.log('[urlMiners] ✅ DocumentMiner loaded');
} catch (e) {
    console.log('[urlMiners] ⚠️ DocumentMiner not available:', e.message);
}

module.exports = {
    // Miners
    playwrightTableMiner,
    aiMiner,
    documentMiner,
    
    // Utilities
    cloudflareDecoder,
    resultMerger,
    
    // Convenience: List of all miners
    getAllMiners: () => {
        const miners = [
            { name: 'PlaywrightTableMiner', mine: playwrightTableMiner.mine }
        ];
        if (aiMiner) {
            miners.push({ name: 'AIMiner', mine: aiMiner.mine });
        }
        if (documentMiner) {
            miners.push({ name: 'DocumentMiner', mine: documentMiner.mine });
        }
        return miners;
    }
};
