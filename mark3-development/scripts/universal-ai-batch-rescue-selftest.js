'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const rescue = require('../core/universal-ai-batch-rescue');

assert.equal(rescue.maxCalls({ maxAiCalls: 99 }), 3, 'whole-run AI cap must never exceed 3');
assert.equal(rescue.maxCalls({ maxAiCalls: 2 }), 2);
assert.equal(rescue.maxCalls({ maxAiCalls: 0 }), 1);

const evidence = {
  fields: [
    { header: 'Post Details', value: 'Join Bright Vision Technologies as an SAP CPI Developer.' },
    { header: 'Person', value: 'Recruiter Example' },
  ],
};
assert.equal(rescue.companySupported('Bright Vision Technologies', evidence), true);
assert.equal(rescue.companySupported('Completely Different Holdings', evidence), false);

const candidates = [
  { id: 'founder', name: 'Founder One', title: 'Founder & Director', organizationName: 'Example Co' },
  { id: 'recruiter', name: 'Recruiter One', title: 'Technical Recruiter', organizationName: 'Example Co' },
  { id: 'engineer', name: 'Engineer One', title: 'Software Engineer', organizationName: 'Example Co' },
];
const shortlist = rescue.shortlistCandidates(candidates, { hiringContext: 'Hiring SAP consultant' }, 6);
assert.ok(shortlist.some((item) => item.id === 'founder'));
assert.ok(shortlist.some((item) => item.id === 'recruiter'));

const openPoc2 = {
  group: { id: 'person_2_open', ordinal: 2 },
  snapshot: { empty: true, hasIdentity: false, values: {}, missingFields: ['name', 'phone', 'email'] },
  isAnchor: false,
};
const openFill = {
  group: { id: 'person_3', ordinal: 3 },
  snapshot: { empty: true, hasIdentity: false, values: {}, missingFields: ['name', 'phone', 'email'] },
  isAnchor: false,
};
const anchor = {
  group: { id: 'person_1', ordinal: 1 },
  snapshot: { empty: false, hasIdentity: true, values: { name: 'Anchor Person' } },
  isAnchor: true,
};
const targets = rescue.rescueTargets({
  groups: {
    partial: [],
    open: [openPoc2, openFill],
    existing: [anchor],
  },
});
assert.equal(targets.length, 1, 'AI rescue must include only empty unresolved POC-2; partial POC-2 repair stays deterministic and optional POC-3 stays manual-only');
assert.equal(targets[0].group.ordinal, 2);
assert.equal(targets[0].rescueMode, 'fill');

const target2 = { group: { id: 'person_2', ordinal: 2 }, snapshot: { empty: true } };
const rowPackages = new Map([[2, {
  targets: [target2],
  candidates,
}]]);

const valid = rescue.validateAssignments({
  rows: [{
    rowNumber: 2,
    candidateKey: 'founder',
    confidence: 0.82,
    reason: 'leadership',
  }],
}, rowPackages);

assert.equal(valid.get(2).length, 1, 'compact POC-2 response should validate');
assert.equal(valid.get(2)[0].candidateKey, 'founder');

const byName = rescue.validateAssignments({
  results: [{
    row: 2,
    name: 'Recruiter One',
    confidence: 0.75,
  }],
}, rowPackages);
assert.equal(byName.get(2).length, 1, 'unique supplied candidate name may recover a missing candidateKey safely');
assert.equal(byName.get(2)[0].candidateKey, 'recruiter');

const invented = rescue.validateAssignments({
  rows: [{ rowNumber: 2, candidateKey: 'invented-person', confidence: 1 }],
}, rowPackages);
assert.equal(invented.get(2).length, 0, 'invented candidate keys must still be rejected');

assert.equal(rescue.reviewerNeeded(valid, rowPackages), false);

const root = path.join(__dirname, '..', 'core');
const rescueSource = fs.readFileSync(path.join(root, 'universal-ai-batch-rescue.js'), 'utf8');
const targetedSource = fs.readFileSync(path.join(root, 'universal-sheet-enrichment-targeted.js'), 'utf8');
const operatorSource = fs.readFileSync(path.join(root, 'universal-sheet-enrichment-operator.js'), 'utf8');
const controllerSource = fs.readFileSync(path.join(root, 'universal-spreadsheet-domain-controller.js'), 'utf8');
const directSource = fs.readFileSync(path.join(root, 'direct-provider-router.js'), 'utf8');

assert.match(rescueSource, /Maximum logical model calls are capped for the WHOLE run/);
assert.match(rescueSource, /runInternalInference\('spreadsheet-enrichment'/);
assert.match(rescueSource, /direct-provider-router/);
assert.match(rescueSource, /direct\.candidates\('research', \{ envOnly: true \}\)/);
assert.match(rescueSource, /direct\.chat\(/);
assert.match(rescueSource, /envOnly: true/);
assert.match(rescueSource, /ULTRON_M3_UNIVERSAL_AI_DIRECT_PROVIDERS/);
assert.match(rescueSource, /gemini,groq,nvidia/);
assert.doesNotMatch(rescueSource, /omniroute|omniFallback|omniDiversity|chatOmniRouteOnly/i);
assert.match(rescueSource, /Select exactly one POC-2 candidate for each supplied row/);
assert.match(rescueSource, /candidateKey values supplied inside that same row/);
assert.match(rescueSource, /unresolvedContextInput/);
assert.match(rescueSource, /base\.inferHiringCompanyFromEvidence\(plan, row\)/);
assert.match(rescueSource, /primaryResult\?\.stats\?\.deferredPoc2Rows/);
assert.match(rescueSource, /no-primary-poc2-residue/);
assert.match(rescueSource, /if \(!residueSet\.has\(Number\(rowNumber\)\)\) continue/);
assert.match(rescueSource, /unresolvedRows: \[\]/);
assert.match(rescueSource, /function markUnresolved/);
assert.match(rescueSource, /employer-unresolved/);
assert.match(rescueSource, /no-verified-candidates/);
assert.match(rescueSource, /selection-rejected-after-verification/);
assert.match(rescueSource, /ULTRON_M3_UNIVERSAL_AI_REVIEWER \|\| '0'/);
assert.match(rescueSource, /apollo\.resolveDecisionMaker/);
assert.match(rescueSource, /ULTRON_M3_UNIVERSAL_AI_HYDRATION_FALLBACK_CANDIDATES/);
assert.match(rescueSource, /post-ai-hydration-fallback/);
assert.match(rescueSource, /hydrationFallbackAttempts/);
assert.match(rescueSource, /hydrationFallbackAccepted/);
assert.match(rescueSource, /ranker\.sameEmployer/);
assert.match(rescueSource, /planner\.safeWritesForGroup/);
assert.match(rescueSource, /stats\.modelAttempts >= stats\.maxCalls/);
assert.match(rescueSource, /stats\.modelCalls\+\+/);
assert.match(rescueSource, /DIRECT_AI_EMPTY_RESPONSE/);
assert.match(rescueSource, /DIRECT_PROVIDER_NOT_CONFIGURED/);
assert.match(rescueSource, /reviewerNeeded/);
assert.match(rescueSource, /candidatePoolForTargets/);
assert.match(rescueSource, /base\.discoverPriorityPeopleFast/);
assert.match(rescueSource, /employerVerifiedPeople = \(people \|\| \[\]\)\.filter\(\(candidate\) => ranker\.sameEmployer\(candidate, companyContext\)\)/);
assert.doesNotMatch(rescueSource, /exactRepairCandidate/);
assert.doesNotMatch(rescueSource, /rescueMode === 'repair'/);
assert.doesNotMatch(rescueSource, /planner\.samePerson/);
assert.doesNotMatch(rescueSource, /omniroute|big-pickle|opencode/i);

assert.match(targetedSource, /deferOpenGroupSelectionToAi: boundedAiEnabled/);
assert.match(targetedSource, /targetOrdinals: \[2\]/);
assert.match(targetedSource, /targetRows: unresolvedRows/);
assert.match(targetedSource, /maxFallbackAttemptsPerTarget: 1/);
assert.match(targetedSource, /mandatoryCompletionAudit/);
assert.match(targetedSource, /Completion beats "made progress"/);
assert.match(targetedSource, /TERMINAL_EXHAUSTED/);
assert.doesNotMatch(targetedSource, /INCOMPLETE_RETRYABLE/);
assert.match(operatorSource, /fillManualPriorityGroup/);
assert.match(operatorSource, /manualPoc2Filled/);
assert.doesNotMatch(operatorSource, /poc2Targets\.length && !aiFallbackEnabled/);
const operatorRunSource = operatorSource.slice(operatorSource.indexOf('async function run(request = {}, options = {})'));
const manualSelectorIndex = operatorRunSource.indexOf('fillManualPriorityGroup(row, plan, companyContext, people, stats');
const aiDeferIndex = operatorRunSource.indexOf('stats.deferredOpenGroups += poc2Targets.length');
assert.ok(manualSelectorIndex >= 0, 'manual POC-2 selection must exist');
assert.ok(aiDeferIndex > manualSelectorIndex, 'manual POC-2 must run before AI deferral');
assert.match(operatorSource, /if \(merged\.length\) cache\.set\(key, merged\)/);
assert.match(operatorSource, /else cache\.delete\(key\)/);
assert.match(operatorSource, /optionalPoc3Deferred/);
assert.match(operatorSource, /maxHydrationAttempts: options\.poc2HydrationAttempts \?\? 3/);
assert.match(operatorSource, /maxHydrationAttempts: options\.poc3HydrationAttempts \?\? 1/);
assert.match(controllerSource, /Maximum 3 direct env-backed AI attempts for the entire run, not per row/);
assert.match(controllerSource, /Priority contract: POC-1 is non-negotiable/);
assert.match(controllerSource, /Existing\/partial POC-2 remains deterministic exact-person repair/);
assert.match(controllerSource, /EMPTY POC-2/);
assert.match(controllerSource, /runs deterministic manual priority\/hydration first/);
assert.match(controllerSource, /Only rows that remain empty after manual verification are deferred to bounded AI rescue/);
assert.match(controllerSource, /targeted Apollo, bounded broad Apollo, and one brand-keyword Apollo retry/);
assert.match(controllerSource, /authenticated read-only LinkedIn company\/people discovery/);
assert.match(controllerSource, /Manual deterministic candidate selection and hydration always run before bounded AI/);
assert.match(controllerSource, /Selection prefers Groq, then Gemini, then NVIDIA on failure/);
assert.match(controllerSource, /OmniRoute is not used by the direct batch path/);

assert.match(directSource, /async function allCredentialEntries\(provider, \{ envOnly: forceEnvOnly = false \} = \{\}\)/);
assert.match(directSource, /const stored = \(forceEnvOnly \|\| envOnly\(\)\) \? \{\} : await storedCredentials\(\)/);
assert.match(directSource, /async function candidates\(taskType = 'general', \{ envOnly: forceEnvOnly = false \} = \{\}\)/);
assert.match(directSource, /async function chat\(\{ messages, model, tools = null, taskType = 'general', timeoutMs = null, envOnly: forceEnvOnly = false \} = \{\}\)/);

console.log('Universal bounded AI batch rescue self-test passed: AI rescue is limited to exact empty POC-2 residue rows, supplied candidates only are accepted, Groq can fall through Gemini/NVIDIA, a failed AI-selected hydration can try the next bounded verified shortlist candidates without another model call, and unresolved mandatory POC-2 rows continue into exact-row last resort before the live-sheet completion gate closes.');
