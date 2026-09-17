'use strict';

// Compatibility domain owner while universal deterministic spreadsheet
// enrichment replaces the legacy fixed 3-POC executor.

const sheets = require('./google-sheets-operator');

// Universal schema/ranking policies must be installed before the universal
// controller/operator are required.
require('./universal-deterministic-bootstrap').install();

const universalController = require('./universal-spreadsheet-domain-controller');
const enrichment = require('./lead-enrichment-bootstrap');
const threePoc = require('./three-poc-enrichment-operator');

// These Apollo-only policies remain useful to both paths: discovery stays broad
// and cheap; deeper contact quality remains bounded to verified final people.
const apolloQuality = require('./apollo-three-poc-quality').install();
const candidateDiscovery = require('./three-poc-candidate-discovery-policy').install();

const LEGACY_WRAPPERS_FLAG = Symbol.for('ultron.mark3.legacyThreePocAiWrappers.installed');
function installLegacyExcelWrappers() {
  if (globalThis[LEGACY_WRAPPERS_FLAG]) return;
  require('./three-poc-linkedin-anchor-fallback').install();
  require('./three-poc-linkedin-profile-resilience').install();
  require('./three-poc-linkedin-profile-normalizer').install();
  require('./three-poc-omniroute-diversity').install();
  globalThis[LEGACY_WRAPPERS_FLAG] = true;
}

const REPORT_FLAG = Symbol.for('ultron.mark3.apolloThreePocQuality.reportInstalled');
if (!globalThis[REPORT_FLAG]) {
  const baseFormatResult = threePoc.formatResult.bind(threePoc);
  threePoc.formatResult = function formatSpreadsheetEnrichmentResult(stats) {
    // Universal deterministic results own their own report. No legacy selector,
    // reviewer, OmniRoute or fixed-slot diagnostics are appended.
    if (stats?.deterministic === true && stats?.modelCalls === 0 && stats?.schema) {
      return baseFormatResult(stats);
    }
    const base = baseFormatResult(stats);
    const quality = apolloQuality.stats();
    const discovery = candidateDiscovery.stats();
    return `${base} Balanced Apollo email quality: ${quality.waterfallStarted}/${quality.maxWaterfalls} final-person waterfall requests started; ${quality.waterfallSucceeded} succeeded, ${quality.waterfallPending} pending, ${quality.waterfallNotFound} not found, ${quality.waterfallCacheHits} reused from cache, ${quality.waterfallCooldownSkips} cooldown skips, ${quality.waterfallBudgetSkips} budget-cap skips, ${quality.waterfallErrors} errors. Personal-email reveal: off. Phone waterfall: off. Zero-credit discovery rescue: ${discovery.domainPrimaryCalls} primary domain searches, ${discovery.domainBroadCalls} broad-domain searches, ${discovery.companyNameTargetedCalls} employer-name targeted searches, ${discovery.companyNameBroadCalls} employer-name broad searches, ${discovery.companyNameRescues} employer-name rescues, ${discovery.emptySearches} exhausted searches.`;
  };
  globalThis[REPORT_FLAG] = true;
}

async function handle(message, context = {}) {
  const original = String(context.originalMessage || message || '');

  // All Google Sheet enrichment, including historical 3-POC wording, uses the
  // universal deterministic engine. There is no model fallback in this path.
  if (sheets.extractSheetUrl(original) || sheets.extractSheetUrl(message)) {
    return universalController.handle(message, context);
  }

  // Attached/local Excel remains a compatibility path for now. Install the old
  // model wrappers lazily only here so they cannot contaminate Google execution.
  installLegacyExcelWrappers();
  apolloQuality.startRun();
  candidateDiscovery.startRun();
  const result = await enrichment.handleThreePocCommand(message, context);
  return result || {
    ok: false,
    text: 'The legacy local-Excel 3-POC compatibility path could not compile this command safely. Apollo was not called and no general model was invoked.',
    response: 'The legacy local-Excel 3-POC compatibility path could not compile this command safely. Apollo was not called and no general model was invoked.',
    error: 'THREE_POC_COMMAND_UNCOMPILED',
    apolloCalled: false,
    model: 'mark3-three-poc-domain-controller',
    provider: 'local-three-poc-control',
    taskType: 'three-poc-enrichment',
  };
}

module.exports = { handle, installLegacyExcelWrappers };
