/**
 * Validators Index
 * Central export for all validation modules
 */

const resultValidator = require('./resultValidator');
const deduplicator = require('./deduplicator');
const qualityChecker = require('./qualityChecker');

module.exports = {
    resultValidator,
    deduplicator,
    qualityChecker,
};
