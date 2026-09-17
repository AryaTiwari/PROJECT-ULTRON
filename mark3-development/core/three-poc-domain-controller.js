'use strict';

// Compatibility owner for historical 3-POC wording. Google Sheets always route
// into the universal deterministic engine. Attached/local Excel retains the
// legacy compatibility executor. Big Pickle no longer owns spreadsheet routing;
// the universal engine may use it only as a bounded ambiguity fallback.

const sheets = require('./google-sheets-operator');
require('./universal-deterministic-bootstrap').install();

const universalController = require('./universal-spreadsheet-domain-controller');
const enrichment = require('./lead-enrichment-bootstrap');
const threePoc = require('./three-poc-enrichment-operator');

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

function defaultUniversalGoogleDispatch(original, message, context) {
  if (sheets.extractSheetUrl(original) || sheets.extractSheetUrl(message)) {
    return universalController.handle(message, context);
  }
  return null;
}

const REPORT_FLAG = Symbol.for('ultron.mark3.apolloThreePocQuality.reportInstalled');
if (!globalThis[REPORT_FLAG]) {
  const baseFormatResult = threePoc.formatResult.bind(threePoc);
  threePoc.formatResult = function formatLegacySpreadsheetEnrichmentResult(stats) {
    const base = baseFormatResult(stats);
    const quality = apolloQuality.stats();
    const discovery = candidateDiscovery.stats();
    return `${base} Balanced Apollo email quality: ${quality.waterfallStarted}/${quality.maxWaterfalls} final-person waterfall requests started; ${quality.waterfallSucceeded} succeeded, ${quality.waterfallPending} pending, ${quality.waterfallNotFound} not found, ${quality.waterfallCacheHits} reused from cache, ${quality.waterfallCooldownSkips} cooldown skips, ${quality.waterfallBudgetSkips} budget-cap skips, ${quality.waterfallErrors} errors. Personal-email reveal: off. Phone waterfall: off. Zero-credit discovery rescue: ${discovery.domainPrimaryCalls} primary domain searches, ${discovery.domainBroadCalls} broad-domain searches, ${discovery.companyNameTargetedCalls} employer-name targeted searches, ${discovery.companyNameBroadCalls} employer-name broad searches, ${discovery.companyNameRescues} employer-name rescues, ${discovery.emptySearches} exhausted searches.`;
  };
  globalThis[REPORT_FLAG] = true;
}

async function handleLegacy(message, context = {}) {
  installLegacyExcelWrappers();
  apolloQuality.startRun();
  candidateDiscovery.startRun();
  const result = await enrichment.handleThreePocCommand(message, context);
  return result || {
    ok: false,
    text: 'The legacy local-Excel 3-POC compatibility path could not compile this command safely. Apollo was not called.',
    response: 'The legacy local-Excel 3-POC compatibility path could not compile this command safely. Apollo was not called.',
    error: 'THREE_POC_COMMAND_UNCOMPILED',
    apolloCalled: false,
    model: 'mark3-three-poc-domain-controller',
    provider: 'local-three-poc-control',
    taskType: 'three-poc-enrichment',
  };
}

async function handle(message, context = {}) {
  const original = String(context.originalMessage || message || '');
  const googleUrl = sheets.extractSheetUrl(original) || sheets.extractSheetUrl(message);

  // Google is always universal-first. Legacy Big Pickle environment variables are
  // intentionally ignored here; Big Pickle now exists only behind the universal
  // bounded fallback service.
  if (googleUrl) return defaultUniversalGoogleDispatch(original, message, context);

  // Attached/local Excel remains isolated on the legacy compatibility path.
  return handleLegacy(message, context);
}

module.exports = {
  handle,
  handleLegacy,
  defaultUniversalGoogleDispatch,
  installLegacyExcelWrappers,
};
