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
assert.equal(targets.length, 2, 'batch rescue should include both identity-bearing partial POCs and empty POCs');
assert.equal(targets[0].rescueMode, 'repair');
assert.equal(targets[1].rescueMode, 'fill');

const repairCandidates = [
  { id: 'low-rank-exact', name: 'Existing Recruiter', title: 'Coordinator', organizationName: 'Example Co' },
  ...candidates,
];
assert.equal(rescue.exactRepairCandidate(targets[0], repairCandidates[0]), true);
const targetAwarePool = rescue.candidatePoolForTargets(repairCandidates, targets, { hiringContext: 'Hiring SAP consultant' }, 3);
assert.ok(targetAwarePool.some((item) => item.id === 'low-rank-exact'), 'existing exact-name repair candidate must survive shortlist pruning');

const target2 = { group: { id: 'person_2', ordinal: 2 }, snapshot: { empty: true } };
const target3 = { group: { id: 'person_3', ordinal: 3 }, snapshot: { empty: true } };
const rowPackages = new Map([[2, {
  targets: [target2, target3],
  candidates,
}]]);

const valid = rescue.validateAssignments({
  rows: [{
    rowNumber: 2,
    assignments: [
      { slot: '2', candidateKey: 'founder', confidence: 0.82, reason: 'leadership' },
      { slot: '3', candidateKey: 'recruiter', confidence: 0.79, reason: 'hiring owner' },
      { slot: '3', candidateKey: 'invented-person', confidence: 1, reason: 'fake' },
    ],
  }],
}, rowPackages);

assert.equal(valid.get(2).length, 2, 'AI may only select supplied candidate keys');
assert.equal(rescue.reviewerNeeded(valid, rowPackages), false);

const weak = rescue.validateAssignments({
  rows: [{
    rowNumber: 2,
    assignments: [{ slot: '2', candidateKey: 'founder', confidence: 0.4, reason: 'uncertain' }],
  }],
}, rowPackages);
assert.equal(rescue.reviewerNeeded(weak, rowPackages), true, 'third pass should trigger only for weak/incomplete rows');

const root = path.join(__dirname, '..', 'core');
const rescueSource = fs.readFileSync(path.join(root, 'universal-ai-batch-rescue.js'), 'utf8');
const targetedSource = fs.readFileSync(path.join(root, 'universal-sheet-enrichment-targeted.js'), 'utf8');
const operatorSource = fs.readFileSync(path.join(root, 'universal-sheet-enrichment-operator.js'), 'utf8');
const controllerSource = fs.readFileSync(path.join(root, 'universal-spreadsheet-domain-controller.js'), 'utf8');

assert.match(rescueSource, /Maximum logical model calls are capped for the WHOLE run/);
assert.match(rescueSource, /runInternalInference\('spreadsheet-enrichment'/);
assert.match(rescueSource, /chatOmniRouteOnly/);
assert.match(rescueSource, /You may choose ONLY candidateKey values supplied inside that same row/);
assert.match(rescueSource, /apollo\.resolveDecisionMaker/);
assert.match(rescueSource, /ranker\.sameEmployer/);
assert.match(rescueSource, /planner\.safeWritesForGroup/);
assert.match(rescueSource, /stats\.modelCalls >= stats\.maxCalls/);
assert.match(rescueSource, /reviewerNeeded/);
assert.match(rescueSource, /rescueMode: 'repair'/);
assert.match(rescueSource, /candidatePoolForTargets/);
assert.match(rescueSource, /planner\.samePerson/);
assert.doesNotMatch(rescueSource, /direct-model|gemini\/|openai\/|anthropic\//i);

assert.match(targetedSource, /deferOpenGroupSelectionToAi: boundedAiEnabled/);
assert.match(targetedSource, /ai-batch-rescue-active/);
assert.match(targetedSource, /Big Pickle per-row fallback was suppressed/);
assert.match(operatorSource, /stats\.deferredOpenGroups \+= fillTargets\.length/);
assert.match(operatorSource, /options\.deferOpenGroupSelectionToAi/);
assert.match(operatorSource, /repairDiscoveryNeeded \|\| \(!deferOpenSelection && fillTargets\.length\)/);
assert.doesNotMatch(operatorSource, /if \(fillTargets\.length \|\| repairDiscoveryNeeded\) \{\s*people = await discoverCompanyPeople/);
assert.match(controllerSource, /maximum 3 logical AI calls for the entire run, not per row/);

console.log('Universal bounded AI batch rescue self-test passed: context + selection are batched across the whole run, partial existing POCs and empty POCs share the same batch, exact repair identities survive shortlist pruning, reviewer is conditional, maximum logical model calls are hard-capped at 3, AI can only select supplied Apollo keys, deterministic Apollo/employer/write verification remains mandatory, and per-row Big Pickle calls are suppressed while batch rescue is active.');
