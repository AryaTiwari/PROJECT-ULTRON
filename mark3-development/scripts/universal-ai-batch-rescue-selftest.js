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
  { id: 'manager', name: 'Manager One', title: 'Talent Acquisition Manager', organizationName: 'Example Co' },
  { id: 'recruiter', name: 'Recruiter One', title: 'Technical Recruiter', organizationName: 'Example Co' },
  { id: 'engineer', name: 'Engineer One', title: 'Software Engineer', organizationName: 'Example Co' },
];
const shortlist = rescue.shortlistCandidates(candidates, { hiringContext: 'Hiring SAP consultant' }, 6);
assert.ok(shortlist.some((item) => item.id === 'founder'));
assert.ok(shortlist.some((item) => item.id === 'manager'));
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
assert.equal(targets.length, 2, 'Production AI rescue must cover every open secondary POC slot in ordinal order');
assert.deepEqual(targets.map((item) => item.group.ordinal), [2, 3]);
assert.ok(targets.every((item) => item.rescueMode === 'fill'));

const target2 = { group: { id: 'person_2', ordinal: 2 }, snapshot: { empty: true } };
const target3 = { group: { id: 'person_3', ordinal: 3 }, snapshot: { empty: true } };
const rowPackages = new Map([[2, {
  targets: [target2],
  candidates,
}]]);
const multiRowPackages = new Map([[2, {
  targets: [target2, target3],
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

const multi = rescue.validateAssignments({
  rows: [{
    rowNumber: 2,
    assignments: [
      { slot: '2', candidateKey: 'founder', confidence: 0.9, reason: 'leadership' },
      { slot: '3', candidateKey: 'manager', confidence: 0.84, reason: 'talent authority' },
    ],
  }],
}, multiRowPackages);
assert.equal(multi.get(2).length, 2, 'multi-slot response should safely validate distinct supplied candidates');
assert.deepEqual(multi.get(2).map((item) => item.target.group.ordinal), [2, 3]);
assert.deepEqual(multi.get(2).map((item) => item.candidateKey), ['founder', 'manager']);
assert.equal(rescue.reviewerNeeded(multi, multiRowPackages), false);

const duplicateCandidate = rescue.validateAssignments({
  rows: [{
    rowNumber: 2,
    assignments: [
      { slot: '2', candidateKey: 'founder' },
      { slot: '3', candidateKey: 'founder' },
    ],
  }],
}, multiRowPackages);
assert.equal(duplicateCandidate.get(2).length, 1, 'one person must never occupy two POC slots in the same row');

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
assert.match(rescueSource, /Fill as many supplied secondary POC targets as can be safely justified/);
assert.match(rescueSource, /Return at most one candidate per target slot and never reuse the same candidate twice/);
assert.match(rescueSource, /candidateKey values supplied inside that same row/);
assert.match(rescueSource, /unresolvedContextInput/);
assert.match(rescueSource, /base\.inferHiringCompanyFromEvidence\(plan, row\)/);
assert.match(rescueSource, /rescueTargetsForRecord\(record\)\.length > 0/);
assert.match(rescueSource, /contactabilityExhaustedTargets/);
assert.match(rescueSource, /base\.contactabilityTargetKey/);
assert.match(rescueSource, /no-open-secondary-poc-residue/);
assert.match(rescueSource, /if \(!residueSet\.has\(Number\(rowNumber\)\)\) continue/);
assert.match(rescueSource, /unresolvedRows: \[\]/);
assert.match(rescueSource, /function markUnresolved/);
assert.match(rescueSource, /employer-unresolved/);
assert.match(rescueSource, /no-verified-candidates/);
assert.match(rescueSource, /selection-rejected-after-verification/);
assert.match(rescueSource, /ULTRON_M3_UNIVERSAL_AI_REVIEWER \|\| '0'/);
assert.match(rescueSource, /base\.hydrateDecisionMakerVerified/);
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

assert.match(targetedSource, /const phasedExecution = options\.pocPhasePipeline === true \|\| Boolean\(options\.contactPhaseOrdinal\)/);
assert.match(targetedSource, /const primary = phasedExecution/);
assert.match(targetedSource, /\? await runPocPhasePipeline\(exact\.request, runOptions\)/);
assert.match(targetedSource, /: await base\.run\(exact\.request, runOptions\)/);
assert.match(targetedSource, /poc-phase-deterministic-only/);
assert.match(targetedSource, /async function runPocPhasePipeline/);
assert.match(targetedSource, /ordinal: 1/);
assert.match(targetedSource, /ordinal: 2/);
assert.match(targetedSource, /ordinal: 3/);
assert.match(targetedSource, /deferOpenGroupSelectionToAi: boundedAiEnabled/);
assert.match(targetedSource, /targetOrdinals: undefined/);
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
assert.match(operatorSource, /An empty result is still useful run-local evidence/);
assert.match(operatorSource, /cache\.set\(key, merged\)/);
assert.doesNotMatch(operatorSource, /else cache\.delete\(key\)/);
assert.match(operatorSource, /optionalPoc3Deferred/);
assert.match(operatorSource, /ULTRON_M3_UNIVERSAL_POC2_HYDRATION_ATTEMPTS \|\| 5/);
assert.match(operatorSource, /ULTRON_M3_UNIVERSAL_POC3_HYDRATION_ATTEMPTS/);
assert.match(operatorSource, /phaseOrdinal === 3 \? 5 : \(!phaseOrdinal \? 3 : 1\)/);
assert.match(operatorSource, /const discoveryTargets = phaseOrdinal === 3[\s\S]*?openPersonTargets/);
assert.match(controllerSource, /Maximum 3 direct env-backed AI attempts apply to the entire run, not per row/);
assert.match(controllerSource, /ordinary production enrichment is coordinated across POC-1, POC-2 and POC-3 in one sheet run/);
assert.match(controllerSource, /POC-1 exact-anchor contact completion runs first within each row/);
assert.match(controllerSource, /existing POC-2\/POC-3 identities remain contact-completion jobs/);
assert.match(controllerSource, /Explicit requests such as POC-1 only, POC-2 only or POC-3 only switch to isolated deterministic diagnostic phases/);
assert.match(controllerSource, /employer verification remains mandatory whenever ULTRON selects a new person/);
assert.match(controllerSource, /results-first waterfall: targeted Apollo -> bounded broad Apollo -> brand\/domain variants -> authenticated read-only LinkedIn/);
assert.match(controllerSource, /pragmatic same-company HR\/talent\/staffing\/placement\/people\/leadership fallback/);
assert.match(controllerSource, /FINAL verified POC whose phone is still blank/);
assert.match(controllerSource, /Apollo native phone reveal with webhook settlement as the production default/);
assert.match(controllerSource, /custom poll_only phone waterfall is experimental\/legacy-only/);
assert.match(controllerSource, /never buys phone enrichment for discovery-only candidates/);
assert.match(controllerSource, /unresolved POC-3 also receives deep deterministic recheck and bounded AI rescue/);
assert.match(controllerSource, /Gemini is preferred for unresolved row\/company context, Groq for candidate assignment, and NVIDIA for optional independent review/);
assert.match(controllerSource, /OmniRoute is not used by the direct batch path/);

assert.match(directSource, /async function allCredentialEntries\(provider, \{ envOnly: forceEnvOnly = false \} = \{\}\)/);
assert.match(directSource, /const stored = \(forceEnvOnly \|\| envOnly\(\)\) \? \{\} : await storedCredentials\(\)/);
assert.match(directSource, /async function candidates\(taskType = 'general', \{ envOnly: forceEnvOnly = false \} = \{\}\)/);
assert.match(directSource, /async function chat\(\{ messages, model, tools = null, taskType = 'general', timeoutMs = null, envOnly: forceEnvOnly = false \} = \{\}\)/);

console.log('Universal bounded AI batch rescue self-test passed: explicit phased execution stays deterministic-only, coordinated production mode can run bounded Gemini/Groq/NVIDIA rescue across multiple open secondary POC slots, only supplied candidates are accepted, one person cannot occupy two slots, and unresolved mandatory POC-2 rows still continue into exact-row last resort before the completion gate closes.');
