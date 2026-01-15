/**
 * Miners Index
 * Central export for all mining modules
 */

const structuredMiner = require('./structuredMiner');
const tableMiner = require('./tableMiner');
const unstructuredMiner = require('./unstructuredMiner');
const labelPatterns = require('./labelPatterns');

module.exports = {
    structuredMiner,
    tableMiner,
    unstructuredMiner,
    labelPatterns,
};
