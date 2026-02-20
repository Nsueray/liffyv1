const buildExecutionPlan = ({ inputType, miningMode, analysis } = {}) => {
  const resolvedInputType = inputType || 'unknown';
  const resolvedMiningMode = miningMode || 'full';

  const plan = [];
  let priority = 1;

  const addStep = (miner, normalizer, reason) => {
    plan.push({
      miner,
      normalizer,
      priority,
      reason,
    });
    priority += 1;
  };

  // Rule-based plan selection by input type and mining mode.

  // Directory sites — directoryMiner handles its own pagination internally.
  // No additional pagination wrapper needed from flowOrchestrator.
  if (resolvedInputType === 'directory') {
    addStep('directoryMiner', 'legacy', 'Business directory extraction');
    if (resolvedMiningMode === 'ai') {
      addStep('aiMiner', 'legacy', 'AI enrichment for directory');
    }
    return plan;
  }

  if (resolvedInputType === 'document') {
    // Primary document context first, then enrich for full/ai modes.
    addStep('documentMiner', 'documentTextNormalizer', 'Primary document context');

    if (resolvedMiningMode === 'full') {
      addStep('playwrightTableMiner', 'legacy', 'Email harvesting');
      addStep('aiMiner', 'legacy', 'AI enrichment');
    }

    if (resolvedMiningMode === 'ai') {
      addStep('aiMiner', 'legacy', 'AI enrichment');
    }

    return plan;
  }

  if (resolvedInputType === 'website') {
    // Website sources prioritize fast table extraction.
    addStep('playwrightTableMiner', 'legacy', 'Primary website tables');

    if (resolvedMiningMode === 'full') {
      addStep('playwrightDetailMiner', 'legacy', 'Deep website details');
      addStep('aiMiner', 'legacy', 'AI enrichment');
    }

    if (resolvedMiningMode === 'ai') {
      addStep('aiMiner', 'legacy', 'AI enrichment');
    }

    return plan;
  }

  if (resolvedInputType === 'table') {
    // Table inputs reuse the table miner as the fastest baseline.
    addStep('playwrightTableMiner', 'legacy', 'Primary table extraction');

    if (resolvedMiningMode === 'full') {
      addStep('aiMiner', 'legacy', 'AI enrichment');
    }

    if (resolvedMiningMode === 'ai') {
      addStep('aiMiner', 'legacy', 'AI enrichment');
    }

    return plan;
  }

  // Unknown input types fall back to a general miner.
  addStep('playwrightMiner', 'legacy', 'General fallback');

  if (resolvedMiningMode === 'full') {
    addStep('aiMiner', 'legacy', 'AI enrichment');
  }

  if (resolvedMiningMode === 'ai') {
    addStep('aiMiner', 'legacy', 'AI enrichment');
  }

  return plan;
};

module.exports = {
  buildExecutionPlan,
};
