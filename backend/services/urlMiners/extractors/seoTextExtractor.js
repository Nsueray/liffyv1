/**
 * seoTextExtractor.js - SEO Text Layer Extractor
 * 
 * Extracts text from SEO-friendly text layers in flipbook platforms.
 * FlipHTML5 embeds full page text in HTML for SEO purposes.
 * 
 * @version 1.0.0
 */

const cheerio = require('cheerio');

const CONFIG = {
    MIN_PAGE_TEXT_LENGTH: 20,
    MIN_TOTAL_PAGES: 2,
};

async function extract(html, url) {
    console.log(`[SEOTextExtractor] Extracting from: ${url}`);

    const result = {
        text: '',
        textBlocks: [],
        method: 'seo_text_layer',
        pageCount: 0,
    };

    try {
        const $ = cheerio.load(html);
        const bodyText = $('body').text();
        const pageBlocks = extractPageBlocks(bodyText);

        if (pageBlocks.length >= CONFIG.MIN_TOTAL_PAGES) {
            console.log(`[SEOTextExtractor] Found ${pageBlocks.length} page blocks`);
            result.textBlocks = pageBlocks;
            result.text = pageBlocks.map(b => b.text).join('\n\n');
            result.pageCount = pageBlocks.length;
            return result;
        }

        // Fallback: cleaned body text
        const cleanedText = cleanText(bodyText);
        if (cleanedText.length > CONFIG.MIN_PAGE_TEXT_LENGTH) {
            console.log(`[SEOTextExtractor] Fallback: ${cleanedText.length} chars`);
            result.text = cleanedText;
            result.textBlocks = [{ page: 1, text: cleanedText }];
            result.pageCount = 1;
        }

        return result;

    } catch (err) {
        console.error(`[SEOTextExtractor] Error: ${err.message}`);
        throw err;
    }
}

function extractPageBlocks(text) {
    const blocks = [];
    const pagePattern = /P:(\d+)([\s\S]*?)(?=P:\d+|$)/gi;
    
    let match;
    while ((match = pagePattern.exec(text)) !== null) {
        const pageNum = parseInt(match[1], 10);
        let pageText = cleanText(match[2]);
        
        if (pageText.length >= CONFIG.MIN_PAGE_TEXT_LENGTH) {
            blocks.push({
                page: pageNum,
                text: pageText,
            });
        }
    }

    blocks.sort((a, b) => a.page - b.page);
    return blocks;
}

function cleanText(text) {
    if (!text) return '';
    
    return text
        .replace(/\s+/g, ' ')
        .replace(/Previous\s*Page|Next\s*Page|Page\s*\d+\s*of\s*\d+/gi, '')
        .replace(/Zoom\s*In|Zoom\s*Out|Full\s*Screen|Download|Share|Print/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function detect(html) {
    const $ = cheerio.load(html);
    const bodyText = $('body').text();
    const pagePattern = /P:\d+/g;
    const matches = bodyText.match(pagePattern) || [];
    
    return {
        hasSeoTextLayer: matches.length >= CONFIG.MIN_TOTAL_PAGES,
        pageCount: matches.length,
        indicators: matches.length > 0 ? [`p_xx_pattern:${matches.length}`] : [],
    };
}

module.exports = {
    extract,
    detect,
    extractPageBlocks,
    cleanText,
};
