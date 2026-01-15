/**
 * Word Document Text Extractor
 * Extracts text from DOCX and DOC files
 * 
 * Methods (in order of preference):
 * 1. mammoth - Best for DOCX, preserves structure
 * 2. adm-zip + XML parse - Manual DOCX extraction
 * 3. Raw string search - Last resort
 */

const fs = require('fs');
const path = require('path');

// Lazy load libraries
let mammoth, AdmZip;
try { mammoth = require('mammoth'); } catch(e) {}
try { AdmZip = require('adm-zip'); } catch(e) {}

/**
 * Main extraction function
 * @param {Buffer} buffer - Word document buffer
 * @param {string} filename - Original filename (to detect .doc vs .docx)
 * @returns {Promise<{text: string, method: string, success: boolean}>}
 */
async function extractText(buffer, filename = '') {
    const result = {
        text: '',
        method: 'none',
        success: false,
        attempts: []
    };

    const ext = path.extname(filename).toLowerCase();
    console.log(`   📄 Word Extractor: ${buffer.length} bytes, type: ${ext || 'unknown'}`);

    // Try each method in order
    const methods = [
        { name: 'mammoth', fn: () => tryMammoth(buffer) },
        { name: 'xml-parse', fn: () => tryXmlParse(buffer) },
        { name: 'raw-string', fn: () => tryRawString(buffer) },
    ];

    for (const method of methods) {
        try {
            console.log(`   [Word] Trying ${method.name}...`);
            const extracted = await method.fn();
            
            result.attempts.push({
                method: method.name,
                chars: extracted.length,
                success: extracted.length > 0
            });

            if (extracted.length > 0) {
                result.text = extracted;
                result.method = method.name;
                result.success = true;
                console.log(`   ✅ ${method.name}: ${extracted.length} chars`);
                break;
            } else {
                console.log(`   ⚠️ ${method.name}: No text extracted`);
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

    // Post-process: Fix common mammoth issues (missing newlines)
    if (result.success) {
        result.text = postProcessWordText(result.text);
    }

    return result;
}

/**
 * Method 1: mammoth (Best for DOCX)
 */
async function tryMammoth(buffer) {
    if (!mammoth) throw new Error('mammoth not available');
    
    const result = await mammoth.extractRawText({ buffer: buffer });
    return result.value || '';
}

/**
 * Method 2: Manual XML parsing (DOCX is a ZIP file)
 */
async function tryXmlParse(buffer) {
    if (!AdmZip) throw new Error('adm-zip not available');
    
    const zip = new AdmZip(buffer);
    const documentXml = zip.getEntry('word/document.xml');
    
    if (!documentXml) {
        throw new Error('word/document.xml not found in archive');
    }
    
    const xmlContent = documentXml.getData().toString('utf8');
    
    // Extract text from XML
    // <w:t>text</w:t> and <w:t xml:space="preserve">text</w:t>
    let text = '';
    const textRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    let match;
    
    while ((match = textRegex.exec(xmlContent)) !== null) {
        text += match[1];
        
        // Check if next element is a paragraph or line break
        const afterMatch = xmlContent.slice(match.index + match[0].length, match.index + match[0].length + 50);
        if (/<\/w:p>|<w:br/.test(afterMatch)) {
            text += '\n';
        }
    }
    
    return cleanText(text);
}

/**
 * Method 3: Raw string extraction
 */
async function tryRawString(buffer) {
    // Try UTF-8 first
    let text = buffer.toString('utf8');
    
    // Look for common patterns
    const hasEmail = /@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text);
    const hasLabels = /\b(company|name|email|phone|firma|isim)\b/i.test(text);
    
    if (hasEmail || hasLabels) {
        // Extract printable text
        text = text.replace(/[^\x20-\x7E\xA0-\xFF\n\r\t]/g, ' ');
        return cleanText(text);
    }
    
    return '';
}

/**
 * Post-process Word text to fix common issues
 */
function postProcessWordText(text) {
    if (!text) return '';
    
    // Common label patterns that should start new lines
    const labelPatterns = [
        // English
        /(?<!^|\n)(Company|Organization|Name|Contact|Email|E-mail|Phone|Tel|Telephone|Country|City|Address|Website|Title|Position)[\s]*:/gi,
        // Turkish
        /(?<!^|\n)(Firma|Şirket|Kuruluş|İsim|Ad|Kişi|Telefon|GSM|Cep|Ülke|Şehir|İl|Adres|Pozisyon|Ünvan)[\s]*:/gi,
        // French
        /(?<!^|\n)(Société|Entreprise|Nom|Prénom|Téléphone|Tél|Pays|Ville|Adresse)[\s]*:/gi,
        // German
        /(?<!^|\n)(Firma|Unternehmen|Name|Ansprechpartner|Telefon|Land|Stadt|Adresse)[\s]*:/gi,
        // Spanish
        /(?<!^|\n)(Empresa|Compañía|Nombre|Contacto|Teléfono|País|Ciudad|Dirección)[\s]*:/gi,
    ];
    
    let processed = text;
    
    for (const pattern of labelPatterns) {
        processed = processed.replace(pattern, '\n$1:');
    }
    
    return cleanText(processed);
}

/**
 * Clean and normalize text
 */
function cleanText(text) {
    if (!text) return '';
    
    return text
        // Normalize line endings
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        // Remove excessive whitespace
        .replace(/[ \t]+/g, ' ')
        // Remove excessive blank lines
        .replace(/\n{3,}/g, '\n\n')
        // Clean up lines
        .split('\n')
        .map(line => line.trim())
        .join('\n')
        // Final trim
        .trim();
}

module.exports = {
    extractText,
    // Export individual methods for testing
    tryMammoth,
    tryXmlParse,
    tryRawString,
    postProcessWordText,
};
