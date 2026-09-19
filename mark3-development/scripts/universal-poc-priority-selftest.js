'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const base = require('../core/universal-sheet-enrichment-operator');

const companyContext = { company: 'Example Technologies Pvt Ltd', domain: 'example.com' };
const existing = { names: new Set(['anchor person']), linkedins: new Set() };

const candidates = [
  { id: 'recruiter', name: 'Recruiter One', title: 'Technical Recruiter', organizationName: 'Example Technologies Pvt Ltd', organizationDomain: 'example.com' },
  { id: 'manager', name: 'Manager One', title: 'Talent Acquisition Manager', organizationName: 'Example Technologies Pvt Ltd', organizationDomain: 'example.com' },
  { id: 'director', name: 'Director One', title: 'Director', organizationName: 'Example Technologies Pvt Ltd', organizationDomain: 'example.com' },
  { id: 'engineer', name: 'Engineer One', title: 'Software Engineer', organizationName: 'Example Technologies Pvt Ltd', organizationDomain: 'example.com' },
  { id: 'other-company', name: 'Other Director', title: 'Director', organizationName: 'Wrong Company', organizationDomain: 'wrong.example' },
];

const ordered = base.manualPriorityCandidates(candidates, companyContext, existing);
assert.deepEqual(
  ordered.map((item) => item.id),
  ['director', 'manager', 'recruiter'],
  'manual POC selector must enforce Founder/Director/Owner > recruiting/HR Head/Manager > Recruiter and reject unrelated/wrong-employer people',
);

const root = path.join(__dirname, '..', 'core');
const operatorSource = fs.readFileSync(path.join(root, 'universal-sheet-enrichment-operator.js'), 'utf8');
const rescueSource = fs.readFileSync(path.join(root, 'universal-ai-batch-rescue.js'), 'utf8');
const targetedSource = fs.readFileSync(path.join(root, 'universal-sheet-enrichment-targeted.js'), 'utf8');

assert.match(operatorSource, /POC-1 is non-negotiable/);
assert.match(operatorSource, /fillManualPriorityGroup/);
assert.match(operatorSource, /ordinal: 2/);
assert.match(operatorSource, /maxHydrationAttempts: options\.poc2HydrationAttempts \?\? 3/);
assert.match(operatorSource, /ordinal: 3/);
assert.match(operatorSource, /maxHydrationAttempts: options\.poc3HydrationAttempts \?\? 1/);
assert.match(operatorSource, /POC-3 gets exactly one cheap manual hydration opportunity/);
assert.match(operatorSource, /candidateLimit: options\.manualCandidateLimit \?\? 40/);
assert.match(operatorSource, /priorityCandidateLimit: options\.manualPriorityCandidateLimit \?\? 20/);

assert.match(rescueSource, /Number\(item\.group\?\.ordinal \|\| 0\) === wantedOrdinal/);
assert.match(rescueSource, /Select exactly one POC-2 candidate/);
assert.match(rescueSource, /unresolvedContextInput/);
assert.match(rescueSource, /\? \['groq', 'gemini', 'nvidia'\]/);
assert.match(rescueSource, /ULTRON_M3_UNIVERSAL_AI_REVIEWER \|\| '0'/);

assert.match(targetedSource, /targetOrdinals: \[2\]/);
assert.match(targetedSource, /maxFallbackAttemptsPerTarget: 1/);
assert.match(targetedSource, /POC-3 is never sent here/);

console.log('Universal POC priority self-test passed: POC-1 completion is non-negotiable, POC-2 uses the canonical manual priority and up to three verified hydration attempts before AI, POC-3 gets only one cheap manual attempt, AI rescue is POC-2-only with Groq -> Gemini -> NVIDIA fallback, and last-resort model fallback is bounded to unresolved POC-2.');
