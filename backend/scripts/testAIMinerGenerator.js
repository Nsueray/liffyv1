/**
 * AI Miner Generator test script.
 * Usage: node backend/scripts/testAIMinerGenerator.js <url>
 *
 * Examples:
 *   node backend/scripts/testAIMinerGenerator.js "https://aiacra.org/membership-directory/"
 *   node backend/scripts/testAIMinerGenerator.js "https://example.com/exhibitors"
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 */

const aiMinerGenerator = require('../services/aiMinerGenerator');

async function main() {
  const url = process.argv[2];

  if (!url) {
    console.error('Usage: node testAIMinerGenerator.js <url>');
    console.error('  Example: node backend/scripts/testAIMinerGenerator.js "https://aiacra.org/membership-directory/"');
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY environment variable not set');
    console.error('  Set it with: export ANTHROPIC_API_KEY=sk-ant-...');
    process.exit(1);
  }

  console.log(`\nTesting AI Miner Generator with URL: ${url}\n`);

  const result = await aiMinerGenerator.generateMiner(url);

  if (result.success) {
    console.log('\n=== SUCCESS ===');
    console.log(`Miner ID: ${result.miner.id}`);
    console.log(`Results: ${result.results.length} contacts`);
    console.log(`Tokens used: ${result.tokensUsed}`);
    console.log(`Execution time: ${result.executionTime}ms`);
    console.log(`Total time: ${result.totalTime}ms`);
    console.log(`Stats: ${JSON.stringify(result.stats, null, 2)}`);
    console.log(`\nSample results (first 5):`);
    result.results.slice(0, 5).forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.company_name || 'N/A'} — ${r.email || 'N/A'} — ${r.phone || 'N/A'}`);
    });
    console.log(`\nStatus: pending_approval — approve with: aiMinerGenerator.approveMiner('${result.miner.id}', userId)`);
  } else {
    console.log('\n=== FAILED ===');
    console.log(`Error: ${result.error}`);
    if (result.results) {
      console.log(`Partial results: ${result.results.length}`);
      result.results.slice(0, 3).forEach((r, i) => {
        console.log(`  ${i + 1}. ${JSON.stringify(r)}`);
      });
    }
    if (result.stats) {
      console.log(`Stats: ${JSON.stringify(result.stats, null, 2)}`);
    }
    if (result.code) {
      console.log(`\nGenerated code:\n${result.code}`);
    }
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
