'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'core');
const fallbackSource = fs.readFileSync(path.join(root, 'universal-big-pickle-fallback.js'), 'utf8');
const fallbackPassSource = fs.readFileSync(path.join(root, 'universal-big-pickle-fallback-pass.js'), 'utf8');
const targetedSource = fs.readFileSync(path.join(root, 'universal-sheet-enrichment-targeted.js'), 'utf8');
const deterministicSource = fs.readFileSync(path.join(root, 'universal-sheet-enrichment-operator.js'), 'utf8');
const controllerSource = fs.readFileSync(path.join(root, 'three-poc-domain-controller.js'), 'utf8');
const approvalSource = fs.readFileSync(path.join(root, 'universal-paid-approval-handler.js'), 'utf8');
const providerSource = fs.readFileSync(path.join(root, 'provider-registry.js'), 'utf8');

// Big Pickle remains unavailable to ordinary automatic model selection.
assert.ok(providerSource.includes('/big[-_ ]?pickle/i'), 'Big Pickle must remain blocked from ordinary auto-routing');

// The deterministic operator itself remains model-free. The fallback is outside
// the primary executor so source/schema/planning/writes cannot become model-owned.
assert.doesNotMatch(deterministicSource, /big-pickle|omniroute|model-router|chatOmniRouteOnly/i);

// The exact-target wrapper owns a phased deterministic primary. In normal POC-phase
// execution AI/Big Pickle are skipped; legacy non-phased compatibility branches remain
// strictly behind the deterministic primary.
assert.match(targetedSource, /const sharedDiscoveryCache = options\.discoveryCache instanceof Map \? options\.discoveryCache : new Map\(\)/);
assert.match(targetedSource, /const phasedExecution = options\.pocPhasePipeline !== false/);
assert.match(targetedSource, /const primary = await runPocPhasePipeline\(exact\.request, runOptions\)/);
assert.match(targetedSource, /skippedReason: 'poc-phase-deterministic-only'/);
assert.match(targetedSource, /aiBatchRescue\.run\(exact\.request, primary, runOptions\)/);
assert.match(targetedSource, /fallbackPass\.run\(exact\.request, primary, runOptions\)/);
const primaryIndex = targetedSource.indexOf('const primary = await runPocPhasePipeline(exact.request, runOptions)');
const phaseSkipIndex = targetedSource.indexOf("skippedReason: 'poc-phase-deterministic-only'");
const aiIndex = targetedSource.indexOf('aiBatchRescue.run(exact.request, primary, runOptions)');
const fallbackIndex = targetedSource.indexOf('fallbackPass.run(exact.request, primary, runOptions)');
assert.ok(primaryIndex >= 0 && phaseSkipIndex > primaryIndex, 'phased deterministic primary must execute before fallback orchestration is considered');
assert.ok(aiIndex > primaryIndex, 'legacy AI rescue must remain behind deterministic primary');
assert.ok(fallbackIndex > primaryIndex, 'legacy Big Pickle fallback must remain behind deterministic primary');
assert.match(targetedSource, /targetOrdinals:\s*\[2\]/);
assert.match(targetedSource, /maxFallbackAttemptsPerTarget:\s*1/);
assert.match(targetedSource, /targetRows:\s*unresolvedRows/);
assert.match(targetedSource, /Completion beats "made progress"/);
assert.match(targetedSource, /mandatoryCompletionAudit/);
assert.match(targetedSource, /TERMINAL_EXHAUSTED/);

// Once primary returns successfully, optional fallback/orchestration problems must
// preserve the primary result instead of reclassifying verified writes as failure.
assert.match(targetedSource, /result = primary/);
assert.match(targetedSource, /postPrimaryError/);
assert.match(targetedSource, /skippedReason: 'fallback-error'/);

// Big Pickle can reason only inside the spreadsheet domain's internal-inference
// scope and only through OmniRoute/OpenCode. No direct personal provider route.
assert.match(fallbackSource, /runInternalInference\('spreadsheet-enrichment'/);
assert.match(fallbackSource, /oc\/big-pickle/);
assert.match(fallbackSource, /skipModelValidation: true/);
assert.doesNotMatch(fallbackSource, /modelRouter\.chat|direct-model|gemini\/|openai\//i);
assert.match(fallbackSource, /personalApiFallbacks:\s*0/);
assert.match(fallbackSource, /select ONLY one candidateKey/);
assert.match(fallbackSource, /Use ONLY the supplied LinkedIn-profile evidence/);

// Fallback post-pass still relies on deterministic Apollo hydration, same-employer
// verification, orphan-contact proof and safeWritesForGroup before any cell write.
assert.match(fallbackPassSource, /base\.hydrateDecisionMakerVerified/);
assert.match(fallbackPassSource, /ranker\.sameEmployer/);
assert.match(fallbackPassSource, /orphanPolicy\.verify/);
assert.match(fallbackPassSource, /planner\.safeWritesForGroup/);
assert.match(fallbackPassSource, /base\.repairExistingGroups/);
assert.match(fallbackPassSource, /base\.inferHiringCompanyFromEvidence\(plan, row\)/);
assert.match(fallbackPassSource, /base\.discoverPriorityPeopleFast/);
assert.match(fallbackPassSource, /allowLinkedInEmployerFallback: false/);

// Historical 3-POC wording may still reach the compatibility controller, but any
// Google Sheet URL must immediately delegate to universal deterministic routing.
assert.match(controllerSource, /Google is always universal-first/);
assert.match(controllerSource, /if \(googleUrl\) return defaultUniversalGoogleDispatch/);
assert.doesNotMatch(controllerSource, /three-poc-big-pickle-override/);

// Final approval reporting must expose actual fallback model use instead of
// falsely stamping every completed run as modelCalls=0.
assert.match(approvalSource, /const modelCalls = Number\(result\?\.modelCalls \|\| 0\)/);
assert.match(approvalSource, /fallbackModelUsed:\s*fallbackUsed/);

const fallback = require('../core/universal-big-pickle-fallback');
assert.equal(fallback.evidenceContainsCompany('Northstar Technologies Pvt. Ltd.', 'Current company: Northstar Technologies'), true);
assert.equal(fallback.evidenceContainsCompany('Completely Different Corp', 'Current company: Northstar Technologies'), false);
assert.equal(fallback.ambiguityReason({ ranked: [{ score: 60, confidence: 0.4 }] }, 0.54), 'low-confidence');
assert.equal(fallback.ambiguityReason({ ranked: [{ score: 60, confidence: 0.7 }, { score: 57, confidence: 0.68 }] }, 0.54), 'close-score');
assert.equal(fallback.ambiguityReason({ ranked: [{ score: 70, confidence: 0.72 }, { score: 50, confidence: 0.65 }] }, 0.54), null);

console.log('Universal Big Pickle fallback self-test passed: phased deterministic execution skips AI/Big Pickle by default, legacy non-phased AI/Big Pickle branches remain strictly behind deterministic primary, exact unresolved POC-2 fallback stays bounded, completion is audited from the live sheet, and Apollo verification still gates writes.');
