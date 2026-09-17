'use strict';

// Compatibility domain owner while universal spreadsheet enrichment replaces
// the legacy 3-POC executor. Google Sheets now go through the deterministic
// universal schema/planning/ranking engine. Attached Excel remains on the legacy
// path until the universal source adapter has equivalent workbook guarantees.

const sheets = require('./google-sheets-operator');
const universalController = require('./universal-spreadsheet-domain-controller');
const enrichment = require('./lead-enrichment-bootstrap');
const threePoc = require('./three-poc-enrichment-operator');
const apolloQuality = require('./apollo-three-poc-quality').install();
const candidateDiscovery = require('./three-poc-candidate-discovery-policy').install();

// Legacy wrappers remain installed ONLY for attached/local Excel compatibility.
// The universal Google path never calls these AI/model wrappers.
require('./three-poc-linkedin-anchor-fallback').install();
require('./three-poc-linkedin-profile-resilience').install();
require('./three-poc-linkedin-profile-normalizer').install();
require('./three-poc-omniroute-diversity').install();

const REPORT_FLAG = Symbol.for('ultron.mark3.apolloThreePocQuality.reportInstalled');
if (!globalThis[REPORT_FLAG]) {
  const baseFormatResult = threePoc.formatResult.bind(threePoc);
  threePoc.formatResult = function formatThreePocWithQuality(stats) {
    // Universal deterministic results own their own truthful report. Do not
    // append legacy 3-POC AI/discovery counters to them.
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
  if (sheets.extractSheetUrl(original) || sheets.extractSheetUrl(message)) {
    return universalController.handle(message, context);
  }

  // Local/attached Excel compatibility path. This is intentionally isolated so
  // universal Google enrichment cannot accidentally fall back to model routing.
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

module.exports = { handle };
