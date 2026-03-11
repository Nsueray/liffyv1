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

// MCE Expocomfort Miner (infinite scroll exhibitor directory)
let mcexpocomfortMiner = null;
try {
    mcexpocomfortMiner = require('./mcexpocomfortMiner');
    console.log('[urlMiners] ✅ McexpocomfortMiner loaded');
} catch (e) {
    console.log('[urlMiners] ⚠️ McexpocomfortMiner not available:', e.message);
}

// ReedExpo Miner (generic ReedExpo platform exhibitor directories)
let reedExpoMiner = null;
try {
    reedExpoMiner = require('./reedExpoMiner');
    console.log('[urlMiners] ✅ ReedExpoMiner loaded');
} catch (e) {
    console.log('[urlMiners] ⚠️ ReedExpoMiner not available:', e.message);
}

// ReedExpo Mailto Miner (ReedExpo sites with mailto: emails in HTML)
let reedExpoMailtoMiner = null;
try {
    reedExpoMailtoMiner = require('./reedExpoMailtoMiner');
    console.log('[urlMiners] ✅ ReedExpoMailtoMiner loaded');
} catch (e) {
    console.log('[urlMiners] ⚠️ ReedExpoMailtoMiner not available:', e.message);
}

module.exports = {
    // Miners
    playwrightTableMiner,
    aiMiner,
    documentMiner,
    mcexpocomfortMiner,
    reedExpoMiner,
    reedExpoMailtoMiner,

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
        if (mcexpocomfortMiner) {
            miners.push({ name: 'McexpocomfortMiner', run: mcexpocomfortMiner.runMcexpocomfortMiner });
        }
        if (reedExpoMiner) {
            miners.push({ name: 'ReedExpoMiner', run: reedExpoMiner.runReedExpoMiner });
        }
        if (reedExpoMailtoMiner) {
            miners.push({ name: 'ReedExpoMailtoMiner', run: reedExpoMailtoMiner.runReedExpoMailtoMiner });
        }
        return miners;
    }
};
