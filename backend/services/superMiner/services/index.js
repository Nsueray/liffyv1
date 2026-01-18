/**
 * services/index.js - SuperMiner v3.1
 * 
 * Central export for all services.
 */

const { EventBus, getEventBus, CHANNELS, publishAggregationDone, publishJobCompleted, publishJobFailed } = require('./eventBus');
const { IntermediateStorage, getIntermediateStorage, TEMP_RESULTS_TTL, MAX_PAYLOAD_SIZE, KEY_PREFIX } = require('./intermediateStorage');
const { CostTracker, getCostTracker, COST_LIMITS, OPERATION_COSTS } = require('./costTracker');

module.exports = {
    // EventBus
    EventBus,
    getEventBus,
    CHANNELS,
    publishAggregationDone,
    publishJobCompleted,
    publishJobFailed,
    
    // IntermediateStorage
    IntermediateStorage,
    getIntermediateStorage,
    TEMP_RESULTS_TTL,
    MAX_PAYLOAD_SIZE,
    KEY_PREFIX,
    
    // CostTracker
    CostTracker,
    getCostTracker,
    COST_LIMITS,
    OPERATION_COSTS
};
