/**
 * PDF Text Extractor
 * Tries multiple methods to extract text from PDF files
 * 
 * Methods (in order of preference):
 * 1. pdftotext (Poppler) - Best for text-based PDFs
 * 2. mutool (MuPDF) - Good for complex layouts
 * 3. pdf-parse (JavaScript) - Fallback
 * 4. Raw extraction - Last resort
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// Lazy load pdf-parse
let pdfParse;
try { pdfParse = require('pdf-parse'); } catch(e) {}

const CONFIG = {
    TIMEOUT: 60000,
    MAX_BUFFER: 50 * 1024 * 1024,
    MIN_TEXT_LENGTH: 20,
};

/**
 * Main extraction function
 * @param {Buffer} buffer - PDF file buffer
 * @returns {Promise<{text: string, method: string, success: boolean}>}
 */
async function extractText(buffer) {
    const tempPath = path.join(os.tmpdir(), `liffy_pdf_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`);
    
    const result = {
        text: '',
        method: 'none',
        success: false,
        attempts: []
    };

    try {
        // Write buffer to temp file
        await fs.promises.writeFile(tempPath, buffer);
        const stats = await fs.promises.stat(tempPath);
        console.log(`   📄 PDF Extractor: ${stats.size} bytes`);

        // Try each method in order
        const methods = [
            { name: 'pdftotext', fn: () => tryPdftotext(tempPath) },
            { name: 'mutool', fn: () => tryMutool(tempPath) },
            { name: 'pdf-parse', fn: () => tryPdfParse(buffer) },
            { name: 'raw', fn: () => tryRawExtraction(buffer) },
        ];

        for (const method of methods) {
            try {
                console.log(`   [PDF] Trying ${method.name}...`);
                const extracted = await method.fn();
                
                result.attempts.push({
                    method: method.name,
                    chars: extracted.length,
                    success: extracted.length >= CONFIG.MIN_TEXT_LENGTH
                });

                if (extracted.length >= CONFIG.MIN_TEXT_LENGTH) {
                    result.text = extracted;
                    result.method = method.name;
                    result.success = true;
                    console.log(`   ✅ ${method.name}: ${extracted.length} chars`);
                    break;
                } else {
                    console.log(`   ⚠️ ${method.name}: Only ${extracted.length} chars`);
                }
            } catch (err) {
                console.log(`   ⚠️ ${method.name} failed: ${err.message.slice(0, 80)}`);
                result.attempts.push({
                    method: method.name,
                    error: err.message.slice(0, 100),
                    success: false
                });
            }
        }

        return result;

    } finally {
        // Cleanup temp file
        try { await fs.promises.unlink(tempPath); } catch (e) {}
    }
}

/**
 * Method 1: pdftotext (Poppler)
 */
async function tryPdftotext(filePath) {
    const { stdout } = await execPromise(
        `pdftotext -layout -enc UTF-8 "${filePath}" -`,
        { timeout: CONFIG.TIMEOUT, maxBuffer: CONFIG.MAX_BUFFER }
    );
    return cleanText(stdout);
}

/**
 * Method 2: mutool (MuPDF)
 */
async function tryMutool(filePath) {
    const { stdout } = await execPromise(
        `mutool draw -F txt -o - "${filePath}"`,
        { timeout: CONFIG.TIMEOUT, maxBuffer: CONFIG.MAX_BUFFER }
    );
    return cleanText(stdout);
}

/**
 * Method 3: pdf-parse (JavaScript library)
 */
async function tryPdfParse(buffer) {
    if (!pdfParse) throw new Error('pdf-parse not available');
    const data = await pdfParse(buffer, { max: 0 });
    return cleanText(data.text);
}

/**
 * Method 4: Raw text extraction from PDF stream
 */
async function tryRawExtraction(buffer) {
    const rawStr = buffer.toString('latin1');
    const extracted = [];
    
    // Method A: Extract text between parentheses (PDF text objects)
    const textMatches = rawStr.match(/\(([^)]{2,})\)/g) || [];
    for (const match of textMatches) {
        const text = match.slice(1, -1);
        if (text.length > 2 && /[a-zA-Z@]/.test(text)) {
            extracted.push(text);
        }
    }
    
    // Method B: Extract from TJ arrays
    const tjMatches = rawStr.match(/\[([^\]]+)\]\s*TJ/g) || [];
    for (const tj of tjMatches) {
        const parts = tj.match(/\(([^)]+)\)/g) || [];
        for (const part of parts) {
            extracted.push(part.slice(1, -1));
        }
    }

    return cleanText(extracted.join(' '));
}

/**
 * Clean and normalize extracted text
 */
function cleanText(text) {
    if (!text) return '';
    
    return text
        // Remove control characters except newlines and tabs
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        // Normalize whitespace
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        // Remove excessive blank lines
        .replace(/\n{3,}/g, '\n\n')
        // Trim
        .trim();
}

module.exports = {
    extractText,
    // Export individual methods for testing
    tryPdftotext,
    tryMutool,
    tryPdfParse,
    tryRawExtraction,
};
