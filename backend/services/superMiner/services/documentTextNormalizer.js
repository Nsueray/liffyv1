/**
 * documentTextNormalizer.js - LIFFY v1.1
 * 
 * Purpose: Convert documentMiner rawText output into UnifiedContact array
 * 
 * RULES (Non-negotiable):
 * 1. This is NOT a miner - it's a pure, stateless normalization function
 * 2. ConfidenceScorer gives limited semantic boost, does NOT override Aggregator rules
 * 3. Only called from documentMiner adapter - not generalized to other miners
 * 
 * @version 1.1.0
 */

const CONFIG = {
    MIN_CONFIDENCE: 25,
    BASE_CONFIDENCE: 25,
    MAX_CONFIDENCE: 45,
    MIN_BLOCK_LENGTH: 30,
    EMAIL_CONTEXT_LINES: 10,
    DEBUG: false,
    // OOM protection: chunk large texts
    CHUNK_THRESHOLD: 200000,  // 200K chars
    CHUNK_SIZE: 100000,       // 100K chars per chunk
    CHUNK_OVERLAP: 500,       // 500 char overlap to avoid splitting mid-line
};

const PATTERNS = {
    email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi,
    
    phone: [
        /(?:\+|00)?233[\s\-\.]?\d{2,3}[\s\-\.]?\d{3}[\s\-\.]?\d{4}/g,
        /(?:\+|00)?\d{1,3}[\s\-\.]?\(?\d{1,4}\)?[\s\-\.]?\d{2,4}[\s\-\.]?\d{2,4}[\s\-\.]?\d{0,4}/g,
    ],
    
    website: /(?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}(?:\/\S*)?/gi,
    
    labels: {
        company: /^([A-Z][A-Za-z0-9\s&.,'-]+(?:Ltd|LLC|Inc|Corp|Co|Company|Limited|GmbH|SA|Pty)?\.?)[\s]*(?:\.{2,}|Pg|\n|$)/m,
        phone: /(?:Mobile|Phone|Tel|GSM|Cell)[\s]*[:\-][\s]*([+\d\s\-().]+)/i,
        country: /(?:Country|Location)[\s]*[:\-][\s]*([A-Za-z\s]+)/i,
        city: /(?:City|Town)[\s]*[:\-][\s]*([A-Za-z\s]+)/i,
        address: /(?:Address|Location)[\s]*[:\-][\s]*([^\n]+)/i,
        website: /(?:Website|Web|URL)[\s]*[:\-][\s]*((?:https?:\/\/)?(?:www\.)?[^\s]+)/i,
    },
    
    emailBlacklist: [
        '.png', '.jpg', '.jpeg', '.gif', '.svg',
        'example.com', 'test.com', 'wix.com', 'sentry.io',
        'noreply', 'no-reply', '@sentry', '@wix'
    ],
    
    genericProviders: [
        'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
        'aol.com', 'icloud.com', 'mail.com', 'yandex.com'
    ],
};

const COUNTRIES = [
    { name: 'Ghana', keywords: ['ghana', 'accra', 'kumasi', 'tema', '+233'] },
    { name: 'Nigeria', keywords: ['nigeria', 'lagos', 'abuja', '+234'] },
    { name: 'Kenya', keywords: ['kenya', 'nairobi', 'mombasa', '+254'] },
    { name: 'South Africa', keywords: ['south africa', 'johannesburg', 'cape town', '+27'] },
    { name: 'Turkey', keywords: ['turkey', 'türkiye', 'istanbul', 'ankara', '+90'] },
    { name: 'UAE', keywords: ['uae', 'dubai', 'emirates', '+971'] },
    { name: 'UK', keywords: ['united kingdom', 'london', 'england', '+44'] },
    { name: 'USA', keywords: ['usa', 'united states', 'america', '+1 '] },
    { name: 'Germany', keywords: ['germany', 'berlin', 'frankfurt', '+49'] },
    { name: 'India', keywords: ['india', 'mumbai', 'delhi', 'bangalore', '+91'] },
    { name: 'China', keywords: ['china', 'beijing', 'shanghai', '+86'] },
];

function debug(...args) {
    if (CONFIG.DEBUG) {
        console.log('[DocumentTextNormalizer]', ...args);
    }
}

function normalize(documentMinerResult, sourceUrl) {
    const startTime = Date.now();

    debug('Starting normalization...');

    if (!documentMinerResult || !documentMinerResult.success) {
        return {
            contacts: [],
            stats: { error: 'Invalid input', parseTime: 0 }
        };
    }

    if (!sourceUrl) {
        return {
            contacts: [],
            stats: { error: 'sourceUrl is required', parseTime: 0 }
        };
    }

    const { extractedText, textBlocks } = documentMinerResult;

    if (!extractedText || extractedText.length < CONFIG.MIN_BLOCK_LENGTH) {
        return {
            contacts: [],
            stats: { error: 'Insufficient text', parseTime: 0 }
        };
    }

    // === OOM PROTECTION: Chunk large texts ===
    if (extractedText.length > CONFIG.CHUNK_THRESHOLD) {
        return normalizeChunked(extractedText, sourceUrl, startTime);
    }

    // === Normal path (≤ 200K chars) ===
    const blocks = splitIntoBlocks(extractedText, textBlocks);
    debug('Split into ' + blocks.length + ' blocks');

    const rawContacts = extractContactsFromBlocks(blocks);
    debug('Extracted ' + rawContacts.length + ' raw contacts');

    const contacts = rawContacts
        .map(raw => buildContact(raw, sourceUrl))
        .filter(c => c !== null && c.confidence >= CONFIG.MIN_CONFIDENCE);

    debug('Built ' + contacts.length + ' valid contacts');

    const parseTime = Date.now() - startTime;

    return {
        contacts,
        stats: {
            totalBlocks: blocks.length,
            rawContactsFound: rawContacts.length,
            validContacts: contacts.length,
            parseTime,
        }
    };
}

/**
 * Chunked normalization for large texts (>200K chars)
 * Splits text into 100K chunks with 500 char overlap, processes each independently,
 * then deduplicates contacts by email across chunks.
 */
function normalizeChunked(extractedText, sourceUrl, startTime) {
    const totalLen = extractedText.length;
    const chunkCount = Math.ceil(totalLen / CONFIG.CHUNK_SIZE);

    console.log(`[DocumentTextNormalizer] Chunked processing: ${totalLen} chars → ${chunkCount} chunks × ${CONFIG.CHUNK_SIZE}`);

    const allContacts = [];
    const seenEmails = new Set();
    let totalRawFound = 0;
    let totalBlocks = 0;

    for (let i = 0; i < chunkCount; i++) {
        const chunkStart = i * CONFIG.CHUNK_SIZE;
        // Overlap: extend end by CHUNK_OVERLAP to avoid cutting mid-record
        const chunkEnd = Math.min(totalLen, chunkStart + CONFIG.CHUNK_SIZE + CONFIG.CHUNK_OVERLAP);

        let chunk = extractedText.substring(chunkStart, chunkEnd);

        // Process chunk
        const blocks = splitIntoBlocks(chunk, null);
        totalBlocks += blocks.length;

        const rawContacts = extractContactsFromBlocks(blocks);
        totalRawFound += rawContacts.length;

        const chunkContacts = rawContacts
            .map(raw => buildContact(raw, sourceUrl))
            .filter(c => c !== null && c.confidence >= CONFIG.MIN_CONFIDENCE);

        // Dedup: skip contacts whose email was already seen in previous chunks
        for (const contact of chunkContacts) {
            if (contact.email && !seenEmails.has(contact.email)) {
                seenEmails.add(contact.email);
                allContacts.push(contact);
            }
        }

        // Memory cleanup — release chunk reference
        chunk = null;

        console.log(`[DocumentTextNormalizer] Chunk ${i + 1}/${chunkCount}: ${chunkContacts.length} contacts (${allContacts.length} total unique)`);
    }

    const parseTime = Date.now() - startTime;

    console.log(`[DocumentTextNormalizer] Chunked complete: ${allContacts.length} unique contacts from ${totalRawFound} raw (${parseTime}ms)`);

    return {
        contacts: allContacts,
        stats: {
            totalBlocks,
            rawContactsFound: totalRawFound,
            validContacts: allContacts.length,
            parseTime,
            chunked: true,
            chunkCount,
        }
    };
}

function splitIntoBlocks(extractedText, textBlocks) {
    if (textBlocks && textBlocks.length > 0) {
        return textBlocks
            .map(b => ({
                page: b.page,
                text: cleanText(b.text),
            }))
            .filter(b => b.text.length >= CONFIG.MIN_BLOCK_LENGTH);
    }
    
    const blocks = [];
    const pagePattern = /P:(\d+)([\s\S]*?)(?=P:\d+|$)/gi;
    
    let match;
    while ((match = pagePattern.exec(extractedText)) !== null) {
        const pageNum = parseInt(match[1], 10);
        const text = cleanText(match[2]);
        
        if (text.length >= CONFIG.MIN_BLOCK_LENGTH) {
            blocks.push({ page: pageNum, text });
        }
    }
    
    if (blocks.length === 0) {
        const cleaned = cleanText(extractedText);
        if (cleaned.length >= CONFIG.MIN_BLOCK_LENGTH) {
            blocks.push({ page: 1, text: cleaned });
        }
    }
    
    return blocks;
}

function cleanText(text) {
    if (!text) return '';
    
    return text
        .replace(/\s+/g, ' ')
        .replace(/\.{3,}/g, ' ')
        .replace(/Pg\s*$/gm, '')
        .trim();
}

function extractContactsFromBlocks(blocks) {
    const contacts = [];
    const processedEmails = new Set();
    
    for (const block of blocks) {
        const blockContacts = extractFromBlock(block, processedEmails);
        contacts.push(...blockContacts);
    }
    
    return contacts;
}

function extractFromBlock(block, processedEmails) {
    const contacts = [];
    const { text, page } = block;
    
    const emails = text.match(PATTERNS.email) || [];
    
    for (const email of emails) {
        const emailLower = email.toLowerCase();
        
        if (processedEmails.has(emailLower)) continue;
        if (isBlacklistedEmail(emailLower)) continue;
        
        processedEmails.add(emailLower);
        
        const context = getEmailContext(text, email);
        
        const websiteResult = extractWebsite(context, emailLower);
        
        const contact = {
            email: emailLower,
            company: extractCompany(context),
            phone: extractPhone(context),
            country: extractCountry(context),
            city: extractCity(context),
            address: extractAddress(context),
            website: websiteResult.url,
            websiteDerivedFromEmail: websiteResult.derivedFromEmail,
            page: page,
            rawContext: context.substring(0, 300),
        };
        
        contacts.push(contact);
    }
    
    return contacts;
}

function isBlacklistedEmail(email) {
    return PATTERNS.emailBlacklist.some(bl => email.includes(bl));
}

function getEmailContext(text, email) {
    const lines = text.split(/\n/);
    const emailIndex = lines.findIndex(l => l.includes(email));
    
    if (emailIndex === -1) {
        const pos = text.indexOf(email);
        const start = Math.max(0, pos - 500);
        const end = Math.min(text.length, pos + 200);
        return text.substring(start, end);
    }
    
    const startLine = Math.max(0, emailIndex - CONFIG.EMAIL_CONTEXT_LINES);
    const endLine = Math.min(lines.length - 1, emailIndex + 3);
    
    return lines.slice(startLine, endLine + 1).join('\n');
}

function extractCompany(context) {
    const labeled = context.match(/Company[\s]*[:\-][\s]*([^\n]+)/i);
    if (labeled && labeled[1]) {
        return cleanFieldValue(labeled[1]);
    }
    
    const lines = context.split('\n').map(l => l.trim()).filter(l => l.length > 3);
    
    for (const line of lines.slice(0, 5)) {
        if (/^(Mobile|Phone|Tel|Email|Fax|Address|City|Country|Website)/i.test(line)) continue;
        
        if (/^[A-Z]/.test(line) && line.length > 3 && line.length < 100) {
            const cleaned = line.replace(/\.{2,}.*$/, '').replace(/\s*Pg\s*$/, '').trim();
            if (cleaned.length > 3) {
                return cleaned;
            }
        }
    }
    
    return null;
}

function extractPhone(context) {
    const labeled = context.match(PATTERNS.labels.phone);
    if (labeled && labeled[1]) {
        const phone = labeled[1].trim();
        if (isValidPhone(phone)) return phone;
    }
    
    for (const pattern of PATTERNS.phone) {
        const matches = context.match(pattern);
        if (matches) {
            for (const match of matches) {
                if (isValidPhone(match)) return match.trim();
            }
        }
    }
    
    return null;
}

function isValidPhone(phone) {
    const digits = phone.replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 15;
}

function extractCountry(context) {
    const labeled = context.match(PATTERNS.labels.country);
    if (labeled && labeled[1]) {
        return cleanFieldValue(labeled[1]);
    }
    
    const contextLower = context.toLowerCase();
    for (const country of COUNTRIES) {
        for (const keyword of country.keywords) {
            if (contextLower.includes(keyword.toLowerCase())) {
                return country.name;
            }
        }
    }
    
    return null;
}

function extractCity(context) {
    const labeled = context.match(PATTERNS.labels.city);
    if (labeled && labeled[1]) {
        return cleanFieldValue(labeled[1]);
    }
    return null;
}

function extractAddress(context) {
    const labeled = context.match(PATTERNS.labels.address);
    if (labeled && labeled[1]) {
        return cleanFieldValue(labeled[1]);
    }
    
    const addressPattern = /(?:No\.?\s*\d+|P\.?O\.?\s*Box\s*\d+)[^\n]*/i;
    const match = context.match(addressPattern);
    if (match) {
        return cleanFieldValue(match[0]);
    }
    
    return null;
}

function extractWebsite(context, email) {
    const labeled = context.match(PATTERNS.labels.website);
    if (labeled && labeled[1]) {
        let website = labeled[1].trim();
        if (!website.startsWith('http')) {
            website = 'https://' + website;
        }
        return { url: website, derivedFromEmail: false };
    }
    
    const urls = context.match(PATTERNS.website) || [];
    for (const url of urls) {
        if (!/facebook|twitter|linkedin|instagram|youtube/i.test(url)) {
            const fullUrl = url.startsWith('http') ? url : 'https://' + url;
            return { url: fullUrl, derivedFromEmail: false };
        }
    }
    
    if (email) {
        const domain = email.split('@')[1];
        if (domain && !PATTERNS.genericProviders.includes(domain)) {
            return { url: 'https://www.' + domain, derivedFromEmail: true };
        }
    }
    
    return { url: null, derivedFromEmail: false };
}

function cleanFieldValue(value) {
    if (!value) return null;
    
    const cleaned = value
        .replace(/\.{2,}/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    
    return cleaned.length > 1 ? cleaned : null;
}

function buildContact(rawContact, sourceUrl) {
    let confidence = CONFIG.BASE_CONFIDENCE;
    
    if (rawContact.company) confidence += 8;
    if (rawContact.phone) confidence += 5;
    if (rawContact.country) confidence += 3;
    
    if (rawContact.website && !rawContact.websiteDerivedFromEmail) {
        confidence += 2;
    }
    
    if (rawContact.city) confidence += 1;
    if (rawContact.address) confidence += 1;
    
    const genericPrefixes = ['info@', 'contact@', 'hello@', 'admin@', 'support@', 'sales@', 'office@'];
    if (!genericPrefixes.some(p => rawContact.email.startsWith(p))) {
        confidence += 3;
    }
    
    confidence = Math.min(CONFIG.MAX_CONFIDENCE, confidence);
    
    return {
        email: rawContact.email,
        company_name: rawContact.company || null,
        contact_name: null,
        phone: rawContact.phone || null,
        country: rawContact.country || null,
        city: rawContact.city || null,
        address: rawContact.address || null,
        website: rawContact.website || null,
        
        confidence: confidence,
        source: 'documentMiner',
        source_url: sourceUrl,
        
        evidence: {
            page: rawContact.page,
            rawContext: rawContact.rawContext,
            extractionMethod: 'documentTextNormalizer',
            websiteDerivedFromEmail: rawContact.websiteDerivedFromEmail || false,
        }
    };
}

module.exports = {
    normalize,
    CONFIG,
    _internal: {
        splitIntoBlocks,
        extractFromBlock,
        extractCompany,
        extractPhone,
        extractCountry,
        extractWebsite,
        buildContact,
    }
};
