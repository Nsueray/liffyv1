/**
 * adapters/index.js - SuperMiner v3.1
 * 
 * Central export for miner adapters.
 */

const { BaseMinerAdapter, createMinerAdapter, wrapMiner, MINER_CAPABILITIES } = require('./baseMinerAdapter');
const { createHttpBasicMinerAdapter } = require('./httpBasicMinerAdapter');
const { createPlaywrightTableMinerAdapter, createPlaywrightDetailMinerAdapter } = require('./playwrightMinerAdapter');
const { createAIMinerAdapter, estimateAICost } = require('./aiMinerAdapter');
const { createWebsiteScraperMinerAdapter, scrapeWebsite, scrapeMultipleWebsites } = require('./websiteScraperMinerAdapter');

module.exports = {
    // Base
    BaseMinerAdapter,
    createMinerAdapter,
    wrapMiner,
    MINER_CAPABILITIES,
    
    // HTTP Basic
    createHttpBasicMinerAdapter,
    
    // Playwright
    createPlaywrightTableMinerAdapter,
    createPlaywrightDetailMinerAdapter,
    
    // AI
    createAIMinerAdapter,
    estimateAICost,
    
    // Website Scraper
    createWebsiteScraperMinerAdapter,
    scrapeWebsite,
    scrapeMultipleWebsites
};
