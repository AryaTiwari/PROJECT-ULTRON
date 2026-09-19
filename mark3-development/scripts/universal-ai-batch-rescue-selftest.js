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

const partialRepair = {
  group: { id: 'person_2', ordinal: 2 },
  snapshot: {
    empty: false,
    hasIdentity: true,
    values: { name: 'Existing Recruiter — Talent Acquisition Specialist', linkedin: '', phone: '', email: '' },
    missingFields: ['phone', 'email'],
  },
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
    partial: [partialRepair],
    open: [openFill],
    existing: [anchor, partialRepair],
  },
});
assert.equal(targets.length, 1, 'AI rescue must be limited to POC-2; optional POC-3 stays manual-only by default');
assert.equal(targets[0].group.ordinal, 2);
assert.equal(targets[0].rescueMode, 'repair');

const repairCandidates = [
  { id: 'low-rank-exact', name: 'Existing Recruiter', title: 'Coordinator', organizationName: 'Example Co' },
  ...candidates,
];
assert.equal(rescue.exactRepairCandidate(targets[0], repairCandidates[0]), true);
const targetAwarePool = rescue.candidatePoolForTargets(repairCandidates, targets, { hiringContext: 'Hiring SAP consultant' }, 3);
assert.ok(targetAwarePool.some((item) => item.id === 'low-rank-exact'), 'existing exact-name repair candidate must survive shortlist pruning');

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
assert.match(rescueSource, /ULTRON_M3_UNIVERSAL_AI_REVIEWER \|\| '0'/);
assert.match(rescueSource, /apollo\.resolveDecisionMaker/);
assert.match(rescueSource, /ranker\.sameEmployer/);
assert.match(rescueSource, /planner\.safeWritesForGroup/);
assert.match(rescueSource, /stats\.modelAttempts >= stats\.maxCalls/);
assert.match(rescueSource, /stats\.modelCalls\+\+/);
assert.match(rescueSource, /DIRECT_AI_EMPTY_RESPONSE/);
assert.match(rescueSource, /DIRECT_PROVIDER_NOT_CONFIGURED/);
assert.match(rescueSource, /reviewerNeeded/);
assert.match(rescueSource, /rescueMode: 'repair'/);
assert.match(rescueSource, /candidatePoolForTargets/);
assert.match(rescueSource, /planner\.samePerson/);
assert.doesNotMatch(rescueSource, /omniroute|big-pickle|opencode/i);

assert.match(targetedSource, /deferOpenGroupSelectionToAi: boundedAiEnabled/);
assert.match(targetedSource, /targetOrdinals: \[2\]/);
assert.match(targetedSource, /maxFallbackAttemptsPerTarget: 1/);
assert.match(operatorSource, /fillManualPriorityGroup/);
assert.match(operatorSource, /manualPoc2Filled/);
assert.match(operatorSource, /optionalPoc3Deferred/);
assert.match(operatorSource, /maxHydrationAttempts: options\.poc2HydrationAttempts \?\? 3/);
assert.match(operatorSource, /maxHydrationAttempts: options\.poc3HydrationAttempts \?\? 1/);
assert.match(controllerSource, /maximum 3 direct AI attempts for the entire run, not per row/);
assert.match(controllerSource, /Priority contract: POC-1 is non-negotiable/);
assert.match(controllerSource, /POC-2 is the primary additional contact/);
assert.match(controllerSource, /POC-3 is optional and receives only one cheap manual attempt/);
assert.match(controllerSource, /Selection prefers Groq, then Gemini, then NVIDIA on failure/);
assert.match(controllerSource, /OmniRoute is not used by the direct batch path/);

assert.match(directSource, /async function allCredentialEntries\(provider, \{ envOnly: forceEnvOnly = false \} = \{\}\)/);
assert.match(directSource, /const stored = \(forceEnvOnly \|\| envOnly\(\)\) \? \{\} : await storedCredentials\(\)/);
assert.match(directSource, /async function candidates\(taskType = 'general', \{ envOnly: forceEnvOnly = false \} = \{\}\)/);
assert.match(directSource, /async function chat\(\{ messages, model, tools = null, taskType = 'general', timeoutMs = null, envOnly: forceEnvOnly = false \} = \{\}\)/);

console.log('Universal bounded AI batch rescue self-test passed: AI rescue is limited to unresolved POC-2, compact/tolerant output parsing accepts only supplied candidates, deterministic employer context skips unnecessary context calls, Groq can fall through to Gemini/NVIDIA, reviewer is off by default, Apollo verification remains mandatory, and one bounded last-resort POC-2 fallback is available after manual + direct AI residue.');
