/**
 * File Mining Orchestrator
 * Coordinates extraction, mining, validation and quality checking
 * 
 * Pipeline:
 * 1. Extract text from file (PDF/Word/Excel)
 * 2. Run multiple miners (structured, table, unstructured)
 * 3. Merge and deduplicate results
 * 4. Validate and clean data
 * 5. Check quality and decide on retries
 * 6. Return final results
 */

const path = require('path');
const db = require('../db');

// Extractors
const { pdfExtractor, wordExtractor, excelExtractor } = require('./extractors');

// Miners
const { structuredMiner, tableMiner, unstructuredMiner } = require('./miners');

// Validators
const { resultValidator, deduplicator, qualityChecker } = require('./validators');

/**
 * Main orchestration function
 * @param {Object} job - Mining job object
 * @returns {Promise<Object>} - Mining result
 */
async function orchestrate(job) {
    const startTime = Date.now();
    
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`📂 FILE MINING ORCHESTRATOR v2.0`);
    console.log(`Job: ${job.id}`);
    console.log(`File: ${job.input}`);
    console.log(`${'═'.repeat(60)}`);

    const result = {
        status: 'SUCCESS',
        contacts: [],
        stats: {
            extraction: {},
            mining: {},
            validation: {},
            quality: {}
        },
        logs: []
    };

    try {
        // Validate job
        if (!job.file_data) {
            throw new Error('No file data found');
        }

        // Ensure buffer
        const buffer = ensureBuffer(job.file_data);
        const filename = job.input || 'unknown';
        const ext = path.extname(filename).toLowerCase();

        console.log(`\n📄 File: ${filename}`);
        console.log(`   Size: ${buffer.length} bytes`);
        console.log(`   Type: ${ext}`);

        // ═══════════════════════════════════════════════════════════════
        // PHASE 1: TEXT EXTRACTION
        // ═══════════════════════════════════════════════════════════════
        console.log(`\n${'─'.repeat(40)}`);
        console.log(`📑 PHASE 1: TEXT EXTRACTION`);
        console.log(`${'─'.repeat(40)}`);

        let extractedText = '';
        let excelData = null;
        let extractionMethod = 'none';

        if (ext === '.pdf') {
            const pdfResult = await pdfExtractor.extractText(buffer);
            extractedText = pdfResult.text;
            extractionMethod = pdfResult.method;
            result.stats.extraction = pdfResult;
            
        } else if (ext === '.docx' || ext === '.doc') {
            const wordResult = await wordExtractor.extractText(buffer, filename);
            extractedText = wordResult.text;
            extractionMethod = wordResult.method;
            result.stats.extraction = wordResult;
            
        } else if (ext === '.xlsx' || ext === '.xls' || ext === '.csv' || ext === '.tsv') {
            excelData = await excelExtractor.extractData(buffer, filename);
            extractedText = excelData.text;
            extractionMethod = excelData.method;
            result.stats.extraction = { method: excelData.method, sheets: excelData.sheets.length };
            
        } else {
            // Try as text file
            extractedText = buffer.toString('utf8');
            extractionMethod = 'text';
            result.stats.extraction = { method: 'text', length: extractedText.length };
        }

        console.log(`   Extraction method: ${extractionMethod}`);
        console.log(`   Text length: ${extractedText.length} chars`);

        // ═══════════════════════════════════════════════════════════════
        // PHASE 2: MINING (Run all miners)
        // ═══════════════════════════════════════════════════════════════
        console.log(`\n${'─'.repeat(40)}`);
        console.log(`⛏️  PHASE 2: MINING`);
        console.log(`${'─'.repeat(40)}`);

        const allContacts = [];
        const miningStats = {};

        // Miner 1: Structured (Label-based)
        if (extractedText.length > 0) {
            console.log(`\n   [1] Structured Miner (Label-based)`);
            const structuredResult = structuredMiner.mine(extractedText);
            allContacts.push(...structuredResult.contacts);
            miningStats.structured = structuredResult.stats;
        }

        // Miner 2: Table (Excel/CSV)
        if (excelData && excelData.sheets && excelData.sheets.length > 0) {
            console.log(`\n   [2] Table Miner (Column-based)`);
            const tableResult = tableMiner.mine(excelData);
            allContacts.push(...tableResult.contacts);
            miningStats.table = tableResult.stats;
        }

        // Miner 3: Unstructured (Regex fallback)
        if (extractedText.length > 0) {
            console.log(`\n   [3] Unstructured Miner (Regex-based)`);
            const unstructuredResult = unstructuredMiner.mine(extractedText);
            allContacts.push(...unstructuredResult.contacts);
            miningStats.unstructured = unstructuredResult.stats;
        }

        console.log(`\n   Total raw contacts: ${allContacts.length}`);
        result.stats.mining = miningStats;

        // ═══════════════════════════════════════════════════════════════
        // PHASE 3: DEDUPLICATION
        // ═══════════════════════════════════════════════════════════════
        console.log(`\n${'─'.repeat(40)}`);
        console.log(`🔄 PHASE 3: DEDUPLICATION`);
        console.log(`${'─'.repeat(40)}`);

        const dedupResult = deduplicator.deduplicate(allContacts);
        result.stats.deduplication = dedupResult.stats;

        console.log(`   ${allContacts.length} → ${dedupResult.contacts.length} contacts`);

        // ═══════════════════════════════════════════════════════════════
        // PHASE 4: VALIDATION & CLEANING
        // ═══════════════════════════════════════════════════════════════
        console.log(`\n${'─'.repeat(40)}`);
        console.log(`✅ PHASE 4: VALIDATION`);
        console.log(`${'─'.repeat(40)}`);

        const validationResult = resultValidator.validateContacts(dedupResult.contacts);
        result.stats.validation = validationResult.stats;

        console.log(`   Valid: ${validationResult.valid.length}`);
        console.log(`   Invalid: ${validationResult.invalid.length}`);

        // ═══════════════════════════════════════════════════════════════
        // PHASE 5: QUALITY CHECK
        // ═══════════════════════════════════════════════════════════════
        console.log(`\n${'─'.repeat(40)}`);
        console.log(`📊 PHASE 5: QUALITY CHECK`);
        console.log(`${'─'.repeat(40)}`);

        const qualityResult = qualityChecker.checkQuality(validationResult.valid, result.stats.extraction);
        result.stats.quality = qualityResult;

        console.log(`   Score: ${qualityResult.score}/100`);
        console.log(`   Decision: ${qualityResult.decision}`);

        // ═══════════════════════════════════════════════════════════════
        // PHASE 6: FINALIZE
        // ═══════════════════════════════════════════════════════════════
        result.contacts = validationResult.valid;
        result.status = qualityResult.decision === 'RETRY' ? 'PARTIAL' : 'SUCCESS';

        // Calculate confidence scores
        for (const contact of result.contacts) {
            contact.confidence = qualityChecker.scoreContact(contact);
        }

        // ═══════════════════════════════════════════════════════════════
        // SAVE TO DATABASE
        // ═══════════════════════════════════════════════════════════════
        console.log(`\n${'─'.repeat(40)}`);
        console.log(`💾 SAVING TO DATABASE`);
        console.log(`${'─'.repeat(40)}`);

        await saveResultsToDb(job, result.contacts, result.stats);

        // ═══════════════════════════════════════════════════════════════
        // SUMMARY
        // ═══════════════════════════════════════════════════════════════
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        
        console.log(`\n${'═'.repeat(60)}`);
        console.log(`📊 MINING COMPLETE`);
        console.log(`${'═'.repeat(60)}`);
        console.log(`   File: ${filename}`);
        console.log(`   Duration: ${duration}s`);
        console.log(`   Contacts: ${result.contacts.length}`);
        console.log(`   Quality: ${qualityResult.score}/100 (${qualityResult.decision})`);
        
        // Show sample contacts
        if (result.contacts.length > 0) {
            console.log(`\n   📧 Sample contacts:`);
            result.contacts.slice(0, 3).forEach((c, i) => {
                console.log(`      ${i + 1}. ${c.email} | ${c.name || '-'} | ${c.company || '-'} | ${c.phone || '-'}`);
            });
        }

        console.log(`${'═'.repeat(60)}\n`);

        return result;

    } catch (err) {
        console.error(`\n❌ ERROR: ${err.message}`);
        console.error(`   Stack: ${err.stack}`);

        result.status = 'FAILED';
        result.error = err.message;

        // Update job as failed
        await updateJobFailed(job.id, err.message);

        throw err;
    }
}

/**
 * Ensure buffer is proper Buffer object
 */
function ensureBuffer(input) {
    if (Buffer.isBuffer(input)) return input;
    
    if (typeof input === 'string') {
        if (input.startsWith('\\x')) {
            return Buffer.from(input.slice(2), 'hex');
        }
        if (/^[A-Za-z0-9+/=]+$/.test(input) && input.length > 100) {
            return Buffer.from(input, 'base64');
        }
        return Buffer.from(input, 'binary');
    }
    
    if (input && input.type === 'Buffer' && Array.isArray(input.data)) {
        return Buffer.from(input.data);
    }
    
    if (input instanceof Uint8Array) {
        return Buffer.from(input);
    }

    throw new Error(`Cannot convert to Buffer: ${typeof input}`);
}

/**
 * Save results to database
 */
async function saveResultsToDb(job, contacts, stats) {
    const client = await db.connect();
    
    try {
        await client.query('BEGIN');
        
        let savedCount = 0;
        let totalEmails = 0;
        
        for (const contact of contacts) {
            const emails = contact.email ? [contact.email] : [];
            totalEmails += emails.length;
            
            await client.query(`
                INSERT INTO mining_results 
                (job_id, organizer_id, source_url, company_name, contact_name, job_title,
                 phone, country, city, address, website, emails, confidence_score, raw)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            `, [
                job.id,
                job.organizer_id,
                contact.website || job.input,
                contact.company || null,
                contact.name || null,
                contact.title || null,
                contact.phone || null,
                contact.country || null,
                contact.city || null,
                contact.address || null,
                contact.website || null,
                emails,
                contact.confidence || null,
                JSON.stringify(contact)
            ]);
            
            savedCount++;
        }
        
        // Build summary
        const summary = {
            ...stats,
            saved_count: savedCount,
            total_emails: totalEmails,
            completed_at: new Date().toISOString()
        };
        
        // Update job
        await client.query(`
            UPDATE mining_jobs 
            SET status = 'completed',
                total_found = $1,
                total_emails_raw = $2,
                stats = $3,
                completed_at = NOW(),
                file_data = NULL
            WHERE id = $4
        `, [savedCount, totalEmails, JSON.stringify(summary), job.id]);
        
        await client.query('COMMIT');
        console.log(`   Saved ${savedCount} contacts to database`);
        
        return { savedCount, totalEmails };
        
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('   Database save error:', err.message);
        throw err;
        
    } finally {
        client.release();
    }
}

/**
 * Update job as failed
 */
async function updateJobFailed(jobId, errorMessage) {
    try {
        await db.query(`
            UPDATE mining_jobs 
            SET status = 'failed', 
                error = $1,
                file_data = NULL
            WHERE id = $2
        `, [errorMessage, jobId]);
    } catch (err) {
        console.error('Failed to update job status:', err.message);
    }
}

/**
 * Legacy compatibility - export as runFileMining
 */
async function runFileMining(job) {
    return orchestrate(job);
}

module.exports = {
    orchestrate,
    runFileMining,
    ensureBuffer,
};
