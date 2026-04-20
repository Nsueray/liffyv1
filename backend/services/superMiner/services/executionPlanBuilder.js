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
    addStep('inlineContactMiner', 'legacy', 'Inline contact fallback (emails from page content)');
    if (resolvedMiningMode === 'ai') {
      addStep('aiMiner', 'legacy', 'AI enrichment for directory');
    }
    return plan;
  }

  // Member table sites — memberTableMiner extracts from HTML tables.
  // Does NOT handle its own pagination (ownPagination: false).
  if (resolvedInputType === 'member_table') {
    addStep('memberTableMiner', 'legacy', 'HTML table member/exhibitor extraction');
    addStep('inlineContactMiner', 'legacy', 'Inline contact fallback (emails from page content)');
    if (resolvedMiningMode === 'ai') {
      addStep('aiMiner', 'legacy', 'AI enrichment for member table');
    }
    return plan;
  }

  // Messe Frankfurt exhibition sites — messeFrankfurtMiner handles API + detail crawl internally.
  // No pagination wrapper needed (ownPagination: true).
  if (resolvedInputType === 'messe_frankfurt') {
    addStep('messeFrankfurtMiner', 'legacy', 'Messe Frankfurt exhibitor extraction');
    if (resolvedMiningMode === 'ai') {
      addStep('aiMiner', 'legacy', 'AI enrichment');
    }
    return plan;
  }

  // Flipbook HTML sites — flipbookMiner handles page iteration internally.
  // No pagination wrapper needed (ownPagination: true).
  if (resolvedInputType === 'flipbook_html') {
    addStep('flipbookMiner', 'legacy', 'Flipbook basic-html page extraction');
    if (resolvedMiningMode === 'ai') {
      addStep('aiMiner', 'legacy', 'AI enrichment');
    }
    return plan;
  }

  // VIS platform sites — visExhibitorMiner handles API + detail crawl internally.
  // No pagination wrapper needed (ownPagination: true).
  if (resolvedInputType === 'vis_exhibitor') {
    addStep('visExhibitorMiner', 'legacy', 'VIS platform exhibitor extraction');
    if (resolvedMiningMode === 'ai') {
      addStep('aiMiner', 'legacy', 'AI enrichment');
    }
    return plan;
  }

  // MCE Expocomfort — infinite scroll exhibitor directory.
  // Handles its own pagination internally (ownPagination: true).
  if (resolvedInputType === 'mce_expocomfort') {
    addStep('mcexpocomfortMiner', 'legacy', 'MCE Expocomfort infinite scroll extraction');
    return plan;
  }

  // ReedExpo mailto — exhibitor directory with mailto: emails in HTML.
  // Handles its own pagination internally (ownPagination: true).
  if (resolvedInputType === 'reed_expo_mailto') {
    addStep('reedExpoMailtoMiner', 'legacy', 'ReedExpo mailto exhibitor extraction');
    return plan;
  }

  // ReedExpo platform — generic exhibitor directory (infinite scroll + GraphQL API).
  // Handles its own pagination internally (ownPagination: true).
  if (resolvedInputType === 'reed_expo') {
    addStep('reedExpoMiner', 'legacy', 'ReedExpo platform exhibitor extraction');
    addStep('reedExpoMailtoMiner', 'legacy', 'ReedExpo mailto enrichment for emailless orgs');
    return plan;
  }

  // Label-value directory — flat HTML with bold company names and label:value pairs.
  // Does NOT handle its own pagination (ownPagination: false).
  if (resolvedInputType === 'label_value') {
    addStep('labelValueMiner', 'legacy', 'Label-value directory extraction');
    addStep('inlineContactMiner', 'legacy', 'Inline contact fallback (emails from page content)');
    if (resolvedMiningMode === 'ai') {
      addStep('aiMiner', 'legacy', 'AI enrichment for label-value directory');
    }
    return plan;
  }

  // SPA catalog sites — spaNetworkMiner handles its own data fetching via network interception.
  // No pagination wrapper needed (ownPagination: true).
  if (resolvedInputType === 'spa_catalog') {
    addStep('spaNetworkMiner', 'legacy', 'SPA catalog network interception');
    if (resolvedMiningMode === 'ai') {
      addStep('aiMiner', 'legacy', 'AI enrichment for SPA catalog');
    }
    return plan;
  }

  if (resolvedInputType === 'document') {
    // Primary document context first, then enrich for ai mode only.
    addStep('documentMiner', 'documentTextNormalizer', 'Primary document context');

    if (resolvedMiningMode === 'full' || resolvedMiningMode === 'free') {
      addStep('playwrightTableMiner', 'legacy', 'Email harvesting');
    }

    if (resolvedMiningMode === 'ai') {
      addStep('aiMiner', 'legacy', 'AI enrichment');
    }

    return plan;
  }

  if (resolvedInputType === 'website') {
    // Website sources prioritize fast table extraction.
    addStep('playwrightTableMiner', 'legacy', 'Primary website tables');
    addStep('inlineContactMiner', 'legacy', 'Inline contact fallback (emails from page content)');

    if (resolvedMiningMode === 'ai') {
      addStep('aiMiner', 'legacy', 'AI enrichment');
    }

    return plan;
  }

  if (resolvedInputType === 'table') {
    // Table inputs reuse the table miner as the fastest baseline.
    addStep('playwrightTableMiner', 'legacy', 'Primary table extraction');
    addStep('inlineContactMiner', 'legacy', 'Inline contact fallback (emails from page content)');

    if (resolvedMiningMode === 'ai') {
      addStep('aiMiner', 'legacy', 'AI enrichment');
    }

    return plan;
  }

  // Unknown input types fall back to a general miner.
  addStep('playwrightMiner', 'legacy', 'General fallback');
  addStep('inlineContactMiner', 'legacy', 'Inline contact fallback (emails from page content)');

  if (resolvedMiningMode === 'ai') {
    addStep('aiMiner', 'legacy', 'AI enrichment');
  }

  return plan;
};

module.exports = {
  buildExecutionPlan,
};
