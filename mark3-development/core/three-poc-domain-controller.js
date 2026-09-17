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
const bigPickle = require('./three-poc-big-pickle-override');
const directTab = require('./three-poc-direct-tab-fallback');

// These Apollo-only policies remain useful to both paths: discovery stays broad
// and cheap; deeper contact quality remains bounded to verified final people.
const apolloQuality = require('./apollo-three-poc-quality').install();
const candidateDiscovery = require('./three-poc-candidate-discovery-policy').install();

function bigPickleMode() {
  return bigPickle.enabled();
}

const LEGACY_WRAPPERS_FLAG = Symbol.for('ultron.mark3.legacyThreePocAiWrappers.installed');
function installLegacyExcelWrappers() {
  if (globalThis[LEGACY_WRAPPERS_FLAG]) return;
  require('./three-poc-linkedin-anchor-fallback').install();
  require('./three-poc-linkedin-profile-resilience').install();
  require('./three-poc-linkedin-profile-normalizer').install();
  // Big Pickle is installed before diversity so, when explicitly enabled, its
  // scoped enrichWorkbook wrapper can override the inner reasoning call for the
  // duration of one run. Outside that run the normal router is restored.
  bigPickle.install();
  require('./three-poc-omniroute-diversity').install();
  // Exact-tab scoping is outermost: even a healthy metadata response is reduced
  // to the configured target tab, and a metadata failure may synthesize only it.
  directTab.install();
  globalThis[LEGACY_WRAPPERS_FLAG] = true;
}

// Keep the normal Google path explicit and independently testable. Temporary
// Big Pickle mode bypasses this helper only when its opt-in environment flag is on.
function defaultUniversalGoogleDispatch(original, message, context) {
  if (sheets.extractSheetUrl(original) || sheets.extractSheetUrl(message)) {
    return universalController.handle(message, context);
  }
  return null;
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
    const pickle = bigPickle.snapshot();
    const tab = directTab.snapshot();
    const pickleText = pickle.enabled
      ? ` Temporary Big Pickle mode: requested ${pickle.requestedModel || 'oc/big-pickle'}, ${pickle.successes}/${pickle.calls} reasoning calls succeeded, ${pickle.failures} failed; actual models [${pickle.actualModels.join(', ') || 'none'}]; personal API fallbacks 0. Exact-tab scope: ${tab.targetSheet || 'unset'}${tab.targetGid != null ? ` (gid ${tab.targetGid})` : ''}; metadata scoped ${tab.metadataScoped}, metadata fallbacks ${tab.metadataFallbacks}, target misses ${tab.targetMisses}.`
      : '';
    return `${base} Balanced Apollo email quality: ${quality.waterfallStarted}/${quality.maxWaterfalls} final-person waterfall requests started; ${quality.waterfallSucceeded} succeeded, ${quality.waterfallPending} pending, ${quality.waterfallNotFound} not found, ${quality.waterfallCacheHits} reused from cache, ${quality.waterfallCooldownSkips} cooldown skips, ${quality.waterfallBudgetSkips} budget-cap skips, ${quality.waterfallErrors} errors. Personal-email reveal: off. Phone waterfall: off. Zero-credit discovery rescue: ${discovery.domainPrimaryCalls} primary domain searches, ${discovery.domainBroadCalls} broad-domain searches, ${discovery.companyNameTargetedCalls} employer-name targeted searches, ${discovery.companyNameBroadCalls} employer-name broad searches, ${discovery.companyNameRescues} employer-name rescues, ${discovery.emptySearches} exhausted searches.${pickleText}`;
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
    text: 'The legacy 3-POC compatibility path could not compile this command safely. Apollo was not called.',
    response: 'The legacy 3-POC compatibility path could not compile this command safely. Apollo was not called.',
    error: 'THREE_POC_COMMAND_UNCOMPILED',
    apolloCalled: false,
    model: bigPickleMode() ? 'mark3-three-poc-big-pickle' : 'mark3-three-poc-domain-controller',
    provider: bigPickleMode() ? 'omniroute/opencode' : 'local-three-poc-control',
    taskType: 'three-poc-enrichment',
  };
}

async function handle(message, context = {}) {
  const original = String(context.originalMessage || message || '');
  const googleUrl = sheets.extractSheetUrl(original) || sheets.extractSheetUrl(message);

  // Normal Google Sheet enrichment remains universal/deterministic. The legacy
  // Google path is re-enabled only when the user explicitly starts temporary
  // Big Pickle mode. This keeps the workaround tightly scoped.
  if (googleUrl && !bigPickleMode()) {
    return defaultUniversalGoogleDispatch(original, message, context);
  }

  if (googleUrl && bigPickleMode()) {
    if (!directTab.targetSheet()) {
      return {
        ok: false,
        text: 'Big Pickle spreadsheet mode requires ULTRON_M3_THREE_POC_TARGET_SHEET so it cannot scan or write the wrong tab.',
        response: 'Big Pickle spreadsheet mode requires ULTRON_M3_THREE_POC_TARGET_SHEET so it cannot scan or write the wrong tab.',
        error: 'BIG_PICKLE_TARGET_SHEET_REQUIRED',
        apolloCalled: false,
        model: 'mark3-three-poc-big-pickle',
        provider: 'local-three-poc-control',
        taskType: 'three-poc-enrichment',
      };
    }
    return handleLegacy(message, context);
  }

  // Attached/local Excel remains on the compatibility path.
  return handleLegacy(message, context);
}

module.exports = { handle, handleLegacy, defaultUniversalGoogleDispatch, installLegacyExcelWrappers, bigPickleMode };
