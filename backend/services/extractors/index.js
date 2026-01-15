/**
 * File Extractors Index
 * Central export for all text extraction modules
 */

const pdfExtractor = require('./pdfExtractor');
const wordExtractor = require('./wordExtractor');
const excelExtractor = require('./excelExtractor');

module.exports = {
    pdfExtractor,
    wordExtractor,
    excelExtractor,
};
