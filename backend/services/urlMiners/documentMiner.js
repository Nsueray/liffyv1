/**
 * documentMiner.js - LIFFY Document Miner v1.2
 * 
 * Purpose: Extract RAW TEXT from Document Viewer platforms
 * (FlipHTML5, Issuu, AnyFlip, Publuu, etc.)
 * 
 * SINGLE RESPONSIBILITY: Extract raw text ONLY
 * 
 * @version 1.2.0
 */

const axios = require('axios');
const cheerio = require('cheerio');

// Import extractors
const seoTextExtractor = require('./extractors/seoTextExtractor');
const jsonTextExtractor = require('./extractors/jsonTextExtractor');

// Import fileMiner for PDF delegation
let fileMiner;
try {
    fileMiner = require('../fileMiner');
} catch (e) {
    console.log('[DocumentMiner] fileMiner not available for PDF delegation');
}

const CONFIG = {
    TIMEOUT: 30000,
    USER_AGENT: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    MIN_TEXT_LENGTH: 300,
};

const EXTRACTION_METHODS = {
    SEO_TEXT_LAYER: 'seo_text_layer',
    JSON_TEXT_API: 'json_text_api',
    PDF_DELEGATION: 'pdf_delegation',
    EMBEDDED_TEXT: 'embedded_text',
};

const CONTENT_PATTERNS = {
    jsonApiIndicators: [
        /pages\.json/i,
        /textContent/i,
        /documentPages/i,
        /pageText/i,
        /bookData/i,
        /"pages"\s*:\s*\[/i,
        /api\/.*\/pages/i,
        /getPageText/i,
        /loadTextLayer/i,
    ],
    seoTextPattern: /P:\d+[\s\S]{20,}?(?=P:\d+|$)/g,
};

class DocumentMiner {
    constructor() {
        this.name = 'DocumentMiner';
        this.version = '1.2.0';
    }

    async mine(url, options = {}) {
        const startTime = Date.now();
        console.log(`[DocumentMiner] ========================================`);
        console.log(`[DocumentMiner] Mining: ${url}`);
        console.log(`[DocumentMiner] Version: ${this.version}`);
        console.log(`[DocumentMiner] ========================================`);

        const result = {
            success: false,
            url,
            extractedText: '',
            textBlocks: [],
            extractionMethod: null,
            pageCount: null,
            stats: {
                startTime: new Date().toISOString(),
                duration: 0,
            },
            errors: [],
        };

        try {
            // Direct PDF URL — download as binary and extract text directly
            try {
                const urlPath = new URL(url).pathname.toLowerCase();
                if (urlPath.endsWith('.pdf')) {
                    console.log(`[DocumentMiner] Direct PDF URL detected, downloading as binary...`);

                    if (!fileMiner || !fileMiner.extractTextFromPDF) {
                        console.log('[DocumentMiner] PDF mining not yet supported — fileMiner not available');
                        result.errors.push('PDF mining requires fileMiner module');
                        result.stats.duration = Date.now() - startTime;
                        return result;
                    }

                    const extracted = await this.extractFromPdf(url, url);
                    if (extracted && extracted.pdfContacts && extracted.pdfContacts.length > 0) {
                        result.success = true;
                        result.extractedText = `[PDF: ${extracted.pdfContacts.length} contacts extracted]`;
                        result.pdfContacts = extracted.pdfContacts;
                        result.extractionMethod = EXTRACTION_METHODS.PDF_DELEGATION;
                        console.log(`[DocumentMiner] ✅ PDF extracted: ${extracted.pdfContacts.length} contacts`);
                    } else if (extracted && extracted.text && extracted.text.length >= CONFIG.MIN_TEXT_LENGTH) {
                        result.success = true;
                        result.extractedText = extracted.text;
                        result.textBlocks = extracted.textBlocks || [];
                        result.extractionMethod = EXTRACTION_METHODS.PDF_DELEGATION;
                        result.pageCount = extracted.pageCount || null;
                        console.log(`[DocumentMiner] ✅ PDF extracted: ${result.extractedText.length} chars`);
                    } else {
                        result.errors.push('PDF extraction returned no contacts or text');
                        console.log(`[DocumentMiner] PDF extraction returned no results`);
                    }

                    result.stats.duration = Date.now() - startTime;
                    return result;
                }
            } catch (pdfErr) {
                console.log(`[DocumentMiner] PDF direct extraction error: ${pdfErr.message}`);
                result.errors.push(`PDF direct: ${pdfErr.message}`);
                // Fall through to normal HTML-based flow
            }

            const html = await this.fetchPage(url);
            if (!html) {
                result.errors.push('Failed to fetch page');
                return result;
            }

            const analysis = this.analyzePage(html, url);
            console.log(`[DocumentMiner] Analysis:`, JSON.stringify(analysis, null, 2));

            const methodsToTry = this.getMethodPriority(analysis);
            
            for (const method of methodsToTry) {
                console.log(`[DocumentMiner] Trying: ${method}`);
                
                try {
                    const extracted = await this.extractWithMethod(method, html, url, analysis);
                    
                    if (extracted && extracted.text && extracted.text.length >= CONFIG.MIN_TEXT_LENGTH) {
                        result.success = true;
                        result.extractedText = extracted.text;
                        result.textBlocks = extracted.textBlocks || [];
                        result.extractionMethod = extracted.method;
                        result.pageCount = extracted.pageCount || null;
                        
                        console.log(`[DocumentMiner] ✅ Success: ${method}`);
                        console.log(`[DocumentMiner]    Text: ${result.extractedText.length} chars`);
                        console.log(`[DocumentMiner]    Pages: ${result.pageCount ?? 'unknown'}`);
                        break;
                    }
                } catch (err) {
                    console.log(`[DocumentMiner] ⚠️ ${method}: ${err.message}`);
                    result.errors.push(`${method}: ${err.message}`);
                }
            }

            if (!result.success) {
                result.errors.push('No extraction method succeeded');
            }

        } catch (err) {
            console.error(`[DocumentMiner] ❌ Error:`, err.message);
            result.errors.push(err.message);
        }

        result.stats.duration = Date.now() - startTime;
        result.stats.endTime = new Date().toISOString();

        // Memory cleanup — release large text blocks after extraction
        // Keep extractedText but clear redundant textBlocks if text is large
        if (result.extractedText && result.extractedText.length > 500000) {
            const blockCount = result.textBlocks?.length || 0;
            result.textBlocks = []; // Free page-level copies
            console.log(`[DocumentMiner] Memory cleanup: cleared ${blockCount} textBlocks (${(result.extractedText.length / 1024).toFixed(0)}KB text retained)`);
        }

        return result;
    }

    async fetchPage(url) {
        try {
            const response = await axios.get(url, {
                timeout: CONFIG.TIMEOUT,
                headers: {
                    'User-Agent': CONFIG.USER_AGENT,
                    'Accept': 'text/html,application/xhtml+xml',
                },
            });
            return response.data;
        } catch (err) {
            console.error(`[DocumentMiner] Fetch error: ${err.message}`);
            return null;
        }
    }

    analyzePage(html, url) {
        const $ = cheerio.load(html);
        const bodyText = $('body').text();
        const scriptContent = $('script').text();
        const fullContent = html + scriptContent;
        
        const seoMatches = bodyText.match(CONTENT_PATTERNS.seoTextPattern) || [];
        const hasSeoTextLayer = seoMatches.length >= 3;
        
        const hasJsonTextApi = CONTENT_PATTERNS.jsonApiIndicators.some(
            pattern => pattern.test(fullContent)
        );
        
        const pdfLink = $('a[href*=".pdf"]').first().attr('href');
        const hasPdfSource = !!pdfLink;
        
        const hasEmbeddedText = bodyText.length > 1000;
        
        return {
            hasSeoTextLayer,
            seoPageCount: seoMatches.length,
            hasJsonTextApi,
            hasPdfSource,
            pdfUrl: pdfLink || null,
            hasEmbeddedText,
            contentLength: html.length,
        };
    }

    getMethodPriority(analysis) {
        const methods = [];
        
        if (analysis.hasSeoTextLayer) methods.push(EXTRACTION_METHODS.SEO_TEXT_LAYER);
        if (analysis.hasJsonTextApi) methods.push(EXTRACTION_METHODS.JSON_TEXT_API);
        if (analysis.hasPdfSource) methods.push(EXTRACTION_METHODS.PDF_DELEGATION);
        if (analysis.hasEmbeddedText) methods.push(EXTRACTION_METHODS.EMBEDDED_TEXT);
        
        if (!methods.includes(EXTRACTION_METHODS.SEO_TEXT_LAYER)) {
            methods.push(EXTRACTION_METHODS.SEO_TEXT_LAYER);
        }
        
        return methods;
    }

    async extractWithMethod(method, html, url, analysis) {
        switch (method) {
            case EXTRACTION_METHODS.SEO_TEXT_LAYER:
                return await seoTextExtractor.extract(html, url);

            case EXTRACTION_METHODS.JSON_TEXT_API:
                return await jsonTextExtractor.extract(url, analysis);

            case EXTRACTION_METHODS.PDF_DELEGATION:
                return await this.extractFromPdf(analysis.pdfUrl, url);

            case EXTRACTION_METHODS.EMBEDDED_TEXT:
                return this.extractEmbeddedText(html);

            default:
                throw new Error(`Unknown method: ${method}`);
        }
    }

    async extractFromPdf(pdfUrl, baseUrl) {
        console.log(`[DocumentMiner] PDF delegation: ${pdfUrl}`);

        if (!fileMiner) {
            throw new Error('fileMiner module not available');
        }

        const fullPdfUrl = pdfUrl.startsWith('http') ? pdfUrl : new URL(pdfUrl, baseUrl).href;

        const response = await axios.get(fullPdfUrl, {
            responseType: 'arraybuffer',
            timeout: CONFIG.TIMEOUT,
            headers: { 'User-Agent': CONFIG.USER_AGENT },
        });

        let buffer = Buffer.from(response.data);
        console.log(`[DocumentMiner] PDF downloaded: ${buffer.length} bytes`);

        // Full extraction: pdfplumber tables + columnar parser + email-centric
        const fileResult = await fileMiner.processFile(buffer, 'download.pdf');

        // Memory cleanup
        buffer = null;
        if (response.data) response.data = null;

        const result = {
            text: '', // Text not needed — contacts extracted directly
            textBlocks: [],
            method: EXTRACTION_METHODS.PDF_DELEGATION,
            pageCount: null,
        };

        // Pass pre-extracted contacts for the adapter to use directly
        if (fileResult.contacts && fileResult.contacts.length > 0) {
            result.pdfContacts = fileResult.contacts;
            console.log(`[DocumentMiner] PDF contacts: ${fileResult.contacts.length} (method: ${fileResult.stats?.extraction_method})`);
        }

        return result;
    }

    extractEmbeddedText(html) {
        const $ = cheerio.load(html);
        $('script, style, noscript').remove();
        
        const text = $('body').text().replace(/\s+/g, ' ').trim();
        
        return {
            text,
            textBlocks: [{ page: 1, text }],
            method: EXTRACTION_METHODS.EMBEDDED_TEXT,
            pageCount: 1,
        };
    }
}

const documentMiner = new DocumentMiner();

module.exports = {
    mine: (url, options) => documentMiner.mine(url, options),
    DocumentMiner,
    EXTRACTION_METHODS,
};
