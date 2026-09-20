'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const scriptsDir = __dirname;
const coreDir = path.join(__dirname, '..', 'core');
const thisFile = path.basename(__filename);

const bannedTestContracts = [
  {
    needle: 'balancedResolveDecisionMaker',
    reason: 'old balanced Apollo wrapper name',
  },
  {
    needle: 'balancedResolvePersonByNameCompany',
    reason: 'old balanced Apollo wrapper name',
  },
  {
    needle: 'return improveVerifiedContacts\\(result, options\\)',
    reason: 'pre-migration wrapper assertion that ignores carried legacy phone request IDs',
  },
  {
    needle: 'generic profile resolution must keep standard credit-saver behavior',
    reason: 'old contract that forbade the results-first exact-profile quality wrapper',
  },
  {
    needle: 'final verified POCs use one bounded poll-only phone waterfall instead of duplicate native+waterfall spend',
    reason: 'old poll-only phone architecture',
  },
  {
    needle: "run_waterfall_phone', 'true'",
    reason: 'custom phone waterfall must not be asserted as the production default',
  },
  {
    needle: 'daily safety budget',
    reason: 'tests must validate the LinkedIn daily-cap condition semantically instead of freezing old user-facing prose',
  },
  {
    needle: 'hourly safety budget',
    reason: 'tests must validate the LinkedIn hourly-cap condition semantically instead of freezing old user-facing prose',
  },
];

const stale = [];
for (const name of fs.readdirSync(scriptsDir)) {
  if (!/selftest\.js$/i.test(name) || name === thisFile) continue;
  const source = fs.readFileSync(path.join(scriptsDir, name), 'utf8');
  for (const contract of bannedTestContracts) {
    if (source.includes(contract.needle)) {
      stale.push({ file: name, reason: contract.reason, needle: contract.needle });
    }
  }
}
assert.deepEqual(
  stale,
  [],
  'Regression suite contains stale contact-architecture assertions: ' + JSON.stringify(stale),
);

const quality = fs.readFileSync(path.join(coreDir, 'apollo-three-poc-quality.js'), 'utf8');
const apollo = fs.readFileSync(path.join(coreDir, 'apollo-enrichment.js'), 'utf8');
const operator = fs.readFileSync(path.join(coreDir, 'universal-sheet-enrichment-operator.js'), 'utf8');
const approval = fs.readFileSync(path.join(coreDir, 'universal-paid-approval-handler.js'), 'utf8');
const rescue = fs.readFileSync(path.join(coreDir, 'universal-ai-batch-rescue.js'), 'utf8');
const diagnostics = fs.readFileSync(path.join(coreDir, 'universal-enrichment-diagnostics.js'), 'utf8');
const control = fs.readFileSync(path.join(coreDir, 'command-control-plane.js'), 'utf8');
const apolloFetch = fs.readFileSync(path.join(coreDir, 'apollo-fetch-hardening.js'), 'utf8');
const spreadsheetController = fs.readFileSync(path.join(coreDir, 'universal-spreadsheet-domain-controller.js'), 'utf8');
const errorVocabulary = fs.readFileSync(path.join(coreDir, 'spreadsheet-enrichment-errors.js'), 'utf8');
const targeted = fs.readFileSync(path.join(coreDir, 'universal-sheet-enrichment-targeted.js'), 'utf8');
const enrichmentDiagnostics = fs.readFileSync(path.join(coreDir, 'universal-enrichment-diagnostics.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const humanErrorTest = fs.readFileSync(path.join(__dirname, 'human-error-vocabulary-selftest.js'), 'utf8');

assert.match(quality, /ULTRON_M3_THREE_POC_PHONE_WATERFALL_EXPERIMENTAL', '0'/);
assert.match(quality, /Native Apollo reveal \+ webhook settlement is the production default/);
assert.match(quality, /resultsFirstResolveDecisionMaker/);
assert.match(quality, /resultsFirstResolvePersonProfile/);
assert.match(quality, /carryLegacyPhoneRequest/);
assert.match(quality, /pendingPhoneWaterfallRequestId/);

assert.match(apollo, /run_waterfall_phone', 'false'/);
assert.match(apollo, /reveal_phone_number', needPhone \? 'true' : 'false'/);
assert.match(apollo, /const apolloFetchHardening = require\('\.\/apollo-fetch-hardening'\)/);
assert.match(apollo, /apolloFetchHardening\.typedNetworkError/);
assert.match(apollo, /lastFailureKind === 'transport'/);

assert.match(quality, /apollo\.fetchApolloResponse/);
assert.doesNotMatch(quality, /\bawait fetch\(/, 'contact-quality Apollo traffic must never bypass typed retry handling');

assert.match(operator, /const requestedPoc3 = !phaseOrdinal && requestedPersonGroups >= 3/);
assert.match(operator, /requestedPoc3Deferred/);
assert.match(operator, /markLeftover\(stats, rowNumber, 'requested-poc3-unresolved'/);

assert.match(approval, /expectedPersonGroups: payload\.expectedPersonGroups \|\| undefined/);
assert.match(approval, /deterministicBootstrap\.install\(\)/);
assert.match(approval, /Preserve provider\/network semantics before applying any universal fallback/);
assert.match(control, /approval-reentry-dispatch/);
assert.match(control, /Universal spreadsheet approval re-entry stopped safely/);
assert.match(apolloFetch, /APOLLO_NETWORK_FETCH_FAILED/);
assert.match(rescue, /Number\(item\.group\?\.ordinal \|\| 0\) >= 2/);
assert.match(diagnostics, /POC3_REQUESTED_UNRESOLVED/);
assert.match(spreadsheetController, /Apollo native phone reveal with webhook settlement as the production default/);
assert.match(spreadsheetController, /custom poll_only phone waterfall is experimental\/legacy-only/);

assert.match(errorVocabulary, /function humanTitleFor/);
assert.match(errorVocabulary, /if \(t === 'RATE_LIMIT'\) return \`\$\{label\} rate limit reached\`/);
assert.match(errorVocabulary, /Google Sheets authorization expired or is invalid/);
assert.match(errorVocabulary, /LinkedIn browser is already busy/);
assert.match(errorVocabulary, /return \`Problem: \${typed\.humanTitle}/);

assert.match(enrichmentDiagnostics, /function issueTitle/);
assert.match(enrichmentDiagnostics, /No verified same-company POC-2 could be found/);
assert.match(enrichmentDiagnostics, /Details:/);
assert.doesNotMatch(targeted, /ROOT_CAUSE:/);
assert.doesNotMatch(targeted, /MANDATORY_BLOCKERS:/);
assert.doesNotMatch(targeted, /ULTRON_DIAGNOSTICS/);
assert.match(targeted, /DIAGNOSTIC SUMMARY/);
assert.match(targeted, /Main problem:/);
assert.match(targeted, /Required blockers:/);
assert.match(targeted, /Completion status:/);
assert.doesNotMatch(targeted, /Completion gate: \$\{gate\.statusCode/);
assert.match(serverSource, /const enrichmentErrors = require\('\.\/core\/spreadsheet-enrichment-errors'\)/);
assert.match(serverSource, /problem: typed\.humanTitle/);
assert.match(serverSource, /explanation: typed\.humanExplanation/);
assert.match(serverSource, /whatToDo: typed\.hint/);
assert.match(humanErrorTest, /Apollo rate limit reached/);
assert.match(humanErrorTest, /Google Sheets authorization expired or is invalid/);
assert.match(humanErrorTest, /LinkedIn safety cooldown is active/);

console.log('Contact architecture contract self-test passed: native Apollo phone reveal is the production default, paid legacy waterfall requests stay resumable, explicit 3-POC intent reaches deep POC-3 rescue, AI rescue accepts all secondary slots, raw Apollo fetch failures cannot bypass typed retries or approval re-entry containment, user-facing diagnostics remain plain English while machine codes stay internal, and stale poll-only regression assertions are absent.');
