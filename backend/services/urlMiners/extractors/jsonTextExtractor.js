/**
 * jsonTextExtractor.js - PLACEHOLDER v1.2
 * 
 * Bu dosya v1.3'te content-based olarak yeniden yazılacak.
 * Su an sadece error throw ediyor.
 * 
 * @version 1.2.0-placeholder
 */

async function extract(url, analysis) {
    console.log('[JSONTextExtractor] Not implemented yet (v1.3 planned)');
    throw new Error('JSON Text Extractor not yet implemented (v1.3 planned)');
}

function detect(url) {
    return {
        hasJsonApi: false,
        platform: null,
        indicators: [],
    };
}

module.exports = { extract, detect };
