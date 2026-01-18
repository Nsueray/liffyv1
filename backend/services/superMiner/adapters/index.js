/**
 * adapters/index.js - SuperMiner v3.1
 * 
 * Central export for miner adapters.
 */

const { BaseMinerAdapter, createMinerAdapter, wrapMiner, MINER_CAPABILITIES } = require('./baseMinerAdapter');

module.exports = {
    BaseMinerAdapter,
    createMinerAdapter,
    wrapMiner,
    MINER_CAPABILITIES
};
