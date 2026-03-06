/**
 * AI Miner Generator test script.
 *
 * v2 (default): AXTree + Config-Driven extraction
 *   node backend/scripts/testAIMinerGenerator.js "https://example.com/directory"
 *   node backend/scripts/testAIMinerGenerator.js "https://example.com/directory" --v2
 *
 * v1 (legacy): JS code generation
 *   node backend/scripts/testAIMinerGenerator.js "https://example.com/directory" --v1
 *
 * AXTree only (debug):
 *   node backend/scripts/testAIMinerGenerator.js "https://example.com/directory" --axtree
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 */

const aiMinerGenerator = require('../services/aiMinerGenerator');

async function main() {
  const url = process.argv[2];
  const flags = process.argv.slice(3);

  if (!url) {
    console.error('Usage: node testAIMinerGenerator.js <url> [--v1|--v2|--axtree]');
    console.error('  --v2     (default) AXTree + Config-Driven extraction');
    console.error('  --v1     Legacy JS code generation');
    console.error('  --axtree Only fetch and display AXTree (no Claude call)');
    console.error('');
    console.error('Examples:');
    console.error('  node backend/scripts/testAIMinerGenerator.js "https://valveworldexpo.com/vis/v1/en/directory/a"');
    console.error('  node backend/scripts/testAIMinerGenerator.js "https://ghanabusinessweb.com/" --v1');
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY && !flags.includes('--axtree')) {
    console.error('ERROR: ANTHROPIC_API_KEY environment variable not set');
    console.error('  Set it with: export ANTHROPIC_API_KEY=sk-ant-...');
    process.exit(1);
  }

  const useV1 = flags.includes('--v1');
  const axTreeOnly = flags.includes('--axtree');

  // ======================================
  // AXTree debug mode
  // ======================================
  if (axTreeOnly) {
    console.log(`\n[AXTree Debug] Fetching AXTree for: ${url}\n`);
    try {
      const axTree = await aiMinerGenerator.getPageAXTree(url);
      console.log(`\n=== AXTree ===`);
      console.log(`Title: ${axTree.title}`);
      console.log(`Size: ${axTree.yaml.length} chars (${(axTree.yaml.length / 1024).toFixed(1)}KB)`);
      console.log(`Token estimate: ~${axTree.tokenEstimate}`);
      console.log(`\n--- YAML ---`);
      // Truncate to first 5000 chars for display
      if (axTree.yaml.length > 5000) {
        console.log(axTree.yaml.substring(0, 5000));
        console.log(`\n... (truncated, ${axTree.yaml.length - 5000} more chars)`);
      } else {
        console.log(axTree.yaml);
      }
      console.log(`--- END ---\n`);

      // Count emails in AXTree
      const emailCount = (axTree.yaml.match(/mailto:|@[a-zA-Z]/g) || []).length;
      console.log(`Email references in AXTree: ${emailCount}`);
      console.log(`Suggested type: ${emailCount > 0 ? 'single_page' : 'multi_step'}`);
    } catch (err) {
      console.error(`AXTree fetch failed: ${err.message}`);
    }
    process.exit(0);
  }

  // ======================================
  // v1 (legacy) mode
  // ======================================
  if (useV1) {
    console.log(`\nTesting AI Miner Generator v1 (legacy) with URL: ${url}\n`);
    const result = await aiMinerGenerator.generateMiner(url);
    printResult(result, 'v1');
    process.exit(0);
  }

  // ======================================
  // v2 (default) mode — AXTree + Config-Driven
  // ======================================
  console.log(`\nTesting AI Miner Generator v2 (AXTree + Config-Driven) with URL: ${url}\n`);
  const result = await aiMinerGenerator.generateMinerV2(url);
  printResult(result, 'v2');
  process.exit(0);
}

function printResult(result, version) {
  if (result.success) {
    console.log(`\n=== SUCCESS (${version}) ===`);
    console.log(`Miner ID: ${result.miner.id}`);
    console.log(`Results: ${result.results.length} contacts`);
    if (result.tokensUsed) console.log(`Tokens used: ${result.tokensUsed}`);
    if (result.totalTime) console.log(`Total time: ${result.totalTime}ms`);
    if (result.config) console.log(`Config type: ${result.config.type}`);
    if (result.iterations) console.log(`Iterations: ${result.iterations}`);
    console.log(`Stats: ${JSON.stringify(result.stats, null, 2)}`);
    console.log(`\nSample results (first 5):`);
    result.results.slice(0, 5).forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.company_name || 'N/A'} — ${r.email || 'N/A'} — ${r.phone || 'N/A'}`);
    });
    if (result.config) {
      console.log(`\nConfig:`);
      console.log(JSON.stringify(result.config, null, 2));
    }
    console.log(`\nStatus: pending_approval — approve with: aiMinerGenerator.approveMiner('${result.miner.id}', userId)`);
  } else {
    console.log(`\n=== FAILED (${version}) ===`);
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
    if (result.config) {
      console.log(`\nConfig:`);
      console.log(JSON.stringify(result.config, null, 2));
    }
    if (result.debugInfo) {
      console.log(`\nDebug info:`);
      console.log(JSON.stringify(result.debugInfo, null, 2));
    }
    if (result.code) {
      console.log(`\nGenerated code:\n${result.code}`);
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
