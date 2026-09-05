const CURRENT_FREE_MODELS = {
  code_build: ['poolside/laguna-xs-2.1', 'deepseek-ai/deepseek-v4-pro-0813', 'deepseek-ai/deepseek-v4-flash-0731', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'minimaxai/minimax-m3'],
  code_review: ['deepseek-ai/deepseek-v4-pro-0813', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'poolside/laguna-xs-2.1', 'deepseek-ai/deepseek-v4-flash-0731'],
  architecture: ['deepseek-ai/deepseek-v4-pro-0813', 'poolside/laguna-xs-2.1', 'nvidia/nemotron-3.5-lightning-30b-a3b'],
  mission_compile: ['deepseek-ai/deepseek-v4-pro-0813', 'poolside/laguna-xs-2.1', 'deepseek-ai/deepseek-v4-flash-0731'],
  automation: ['poolside/laguna-xs-2.1', 'deepseek-ai/deepseek-v4-pro-0813', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'deepseek-ai/deepseek-v4-flash-0731'],
};

const PROFILES = {
  repair: { id: 'repair', label: 'Focused repair', maxJobs: 4, principle: 'Reproduce first, patch the smallest surface, add a regression test, verify. Do not redesign working systems.' },
  integration: { id: 'integration', label: 'API / connector integration', maxJobs: 7, principle: 'Define the external contract and credential boundary, build a read-only verification path first, then dry-run writes, then approval-gated live action.' },
  automation: { id: 'automation', label: 'Durable automation', maxJobs: 8, principle: 'Prioritize idempotency, state/checkpoints, retries, dedupe, observability, approval gates and restart safety over UI polish.' },
  creator_ops: { id: 'creator_ops', label: 'Creator / Elevate operator feature', maxJobs: 8, principle: 'Optimize for creator growth operations: real inputs, measurable outputs, account-fit intelligence, approval-gated outreach/publishing and reusable data for CUP/Performance OS.' },
  media_pipeline: { id: 'media_pipeline', label: 'Creator media pipeline', maxJobs: 8, principle: 'Treat creative quality as a product requirement: account aesthetic, information density, narrator, edit grammar, final render verification and feedback/performance learning.' },
  product_feature: { id: 'product_feature', label: 'Existing-product feature', maxJobs: 6, principle: 'Modify the existing codebase in place, preserve working behavior, integrate with current state/memory/operator layers and add regression coverage.' },
  full_product: { id: 'full_product', label: 'Large product build', maxJobs: 10, principle: 'Build the smallest complete vertical slice first, then expand. Avoid documentation-only jobs and avoid over-fragmenting work into model-heavy microtasks.' },
};

function classify(objective = '') {
  const text = String(objective || '').toLowerCase();
  if (/\b(?:fix|bug|repair|broken|regression|error|fails?|failing|not working|refactor)\b/.test(text) && !/\b(?:complete|entire|end[- ]to[- ]end|from scratch|rebuild|large migration)\b/.test(text)) return PROFILES.repair;
  // Explicit provider/API/OAuth/webhook work is primarily an integration contract even
  // when the business feature is Instagram, creator ops or Reel Factory.
  if (/\b(?:api|oauth|webhook|connector|connect|integration|integrate|sync|provider|token|permission)\b/.test(text)) return PROFILES.integration;
  if (/\b(?:reel factory|reel intelligence|video pipeline|caption|narrator|b-roll|ffmpeg|short-form|short form|video editor)\b/.test(text)) return PROFILES.media_pipeline;
  if (/\b(?:instagram dm|instagram publish|creator research|lead extraction|creator upgrade|\bcup\b|linkedin publish|social media manager|creator operator|elevate os)\b/.test(text)) return PROFILES.creator_ops;
  if (/\b(?:automation|workflow|pipeline|scheduled|monitor|watch|ingest|queue|cron|follow[- ]?up|autonomous agent)\b/.test(text)) return PROFILES.automation;
  if (/\b(?:app|application|platform|saas|crm|operating system|complete system|full system|from scratch)\b/.test(text)) return PROFILES.full_product;
  return PROFILES.product_feature;
}

function shouldDelegate(message = '') {
  const text = String(message || '').trim();
  if (!text) return false;
  if (/\b(?:how do i|how can i|how should i|explain|teach me|guide me|what is|what are)\b/i.test(text)) return false;
  if (/\bforge\b|\bmulti[- ]agent\b|\bteam of agents\b/i.test(text)) return true;
  const profile = classify(text);
  if (profile.id === 'repair') return /\b(?:entire|across the whole|large migration|many files|multi-module|end[- ]to[- ]end)\b/i.test(text);
  const action = /\b(?:build|create|develop|implement|automate|integrate|connect|design|make)\b/i.test(text);
  if (!action) return false;
  if (['integration', 'automation', 'creator_ops', 'media_pipeline', 'full_product'].includes(profile.id)) return true;
  return /\b(?:complete|full|end[- ]to[- ]end|project|system|feature spanning|multiple modules|autonomously)\b/i.test(text);
}

function commonAcceptance() {
  return ['Preserve existing working behavior', 'No paid inference or paid fallback', 'Run executable validation', 'Report exact remaining blockers honestly'];
}

function fallbackJobs(objective, profile = classify(objective)) {
  const common = commonAcceptance();
  if (profile.id === 'repair') return [
    { id: 'reproduce', title: 'Reproduce and isolate', objective: `Reproduce the failure and isolate the smallest root cause for: ${objective}`, kind: 'qa', worker: 'reasoning', dependsOn: [], acceptance: ['Name the root cause', 'Identify the smallest affected surface'] },
    { id: 'patch', title: 'Minimal repair', objective: 'Patch only the proven root cause while preserving working behavior.', kind: 'integration', worker: 'coding', dependsOn: ['reproduce'], acceptance: common },
    { id: 'regression', title: 'Regression proof', objective: 'Add or strengthen regression coverage and run the relevant checks.', kind: 'qa', worker: 'review', dependsOn: ['patch'], acceptance: ['Original failure no longer reproduces', 'Relevant existing checks still pass'] },
  ];
  if (profile.id === 'integration') return [
    { id: 'contract', title: 'Integration contract', objective: `Define the exact API/OAuth/webhook contract, permissions, credential boundary, read/write operations and failure modes for: ${objective}`, kind: 'architect', worker: 'reasoning', dependsOn: [], acceptance: ['No secrets in code/logs', 'Read/write permission boundary is explicit'] },
    { id: 'connector', title: 'Connector implementation', objective: 'Implement the connector with timeouts, sanitized errors, rate-limit handling and safe credential lookup.', kind: 'integration', worker: 'coding', dependsOn: ['contract'], acceptance: common },
    { id: 'readonly', title: 'Read-only verification', objective: 'Prove identity/status/read operations before enabling any external write.', kind: 'qa', worker: 'review', dependsOn: ['connector'], acceptance: ['Read-only verification evidence exists'] },
    { id: 'write-path', title: 'Approval-gated write path', objective: 'Implement dry-run and explicit-approval live writes without silently executing external side effects.', kind: 'integration', worker: 'coding', dependsOn: ['readonly'], acceptance: ['Dry-run path exists', 'External writes require approval'] },
    { id: 'integration-review', title: 'Integration final review', objective: 'Verify permissions, retry behavior, secret hygiene, dry-run/live separation and restart safety.', kind: 'critic', worker: 'review', dependsOn: ['write-path'], acceptance: common },
  ];
  if (profile.id === 'automation') return [
    { id: 'workflow-contract', title: 'Automation contract', objective: `Define trigger, state, idempotency key, dedupe rules, retry policy, checkpoints, approval gates and success evidence for: ${objective}`, kind: 'automation', worker: 'reasoning', dependsOn: [], acceptance: ['Trigger and terminal states are explicit', 'Duplicate execution is prevented'] },
    { id: 'state-engine', title: 'State and checkpoint layer', objective: 'Implement durable state/checkpoints so the automation resumes safely after restart or provider failure.', kind: 'backend', worker: 'coding', dependsOn: ['workflow-contract'], acceptance: common },
    { id: 'automation-build', title: 'Automation execution path', objective: 'Implement the actual workflow using deterministic tools first and AI only where judgment is required.', kind: 'automation', worker: 'coding', dependsOn: ['state-engine'], acceptance: common },
    { id: 'failure-recovery', title: 'Failure recovery', objective: 'Add bounded retries, rate-limit handling, dead-letter/blocker state and human approval transitions.', kind: 'integration', worker: 'coding', dependsOn: ['automation-build'], acceptance: common },
    { id: 'automation-qa', title: 'Restart + idempotency QA', objective: 'Simulate retry/restart/duplicate-trigger scenarios and verify no duplicate external action occurs.', kind: 'qa', worker: 'review', dependsOn: ['failure-recovery'], acceptance: ['Restart safety verified', 'Idempotency verified'] },
  ];
  if (profile.id === 'creator_ops') return [
    { id: 'operator-contract', title: 'Creator operator contract', objective: `Define creator input, account/data source, business objective, measurable output, approval boundary and state transitions for: ${objective}`, kind: 'product', worker: 'reasoning', dependsOn: [], acceptance: ['Creator outcome is measurable', 'External actions are approval-gated'] },
    { id: 'data-contract', title: 'Creator data contract', objective: 'Define reusable data objects that can feed Reel Intelligence, Performance OS, lead state and CUP automation rather than creating isolated feature data.', kind: 'database', worker: 'reasoning', dependsOn: ['operator-contract'], acceptance: ['Data is reusable across operator capabilities'] },
    { id: 'operator-build', title: 'Operator implementation', objective: 'Implement the working creator/business operator feature and integrate it with existing Operator Mode and Adaptive Intelligence.', kind: 'integration', worker: 'coding', dependsOn: ['data-contract'], acceptance: common },
    { id: 'dry-run', title: 'Dry-run simulation', objective: 'Run a realistic no-side-effect scenario and capture evidence, outputs and failure handling.', kind: 'qa', worker: 'review', dependsOn: ['operator-build'], acceptance: ['Dry-run produces useful founder-facing output'] },
    { id: 'learning-hook', title: 'Outcome learning hook', objective: 'Connect approvals, corrections and real outcome metrics back into Adaptive Intelligence where appropriate.', kind: 'integration', worker: 'coding', dependsOn: ['dry-run'], acceptance: common },
    { id: 'creator-review', title: 'Creator operator final review', objective: 'Verify founder UX, measurable outcome, approval safety, state continuity and cross-feature data reuse.', kind: 'critic', worker: 'review', dependsOn: ['learning-hook'], acceptance: common },
  ];
  if (profile.id === 'media_pipeline') return [
    { id: 'creative-contract', title: 'Creative intelligence contract', objective: `Define audience goal, account aesthetic, current format evidence, script density, narrator, text/graphics grammar and final quality bar for: ${objective}`, kind: 'product', worker: 'reasoning', dependsOn: [], acceptance: ['Creative decisions are explainable', 'No trend is copied blindly'] },
    { id: 'media-build', title: 'Media pipeline implementation', objective: 'Implement the requested Reel/media capability inside the existing Reel Intelligence → Factory → Quality Judge loop.', kind: 'integration', worker: 'coding', dependsOn: ['creative-contract'], acceptance: common },
    { id: 'render-test', title: 'Representative render test', objective: 'Render a realistic example and validate file, audio, composition, text safe-zones and information completeness.', kind: 'qa', worker: 'review', dependsOn: ['media-build'], acceptance: ['Representative render evidence exists'] },
    { id: 'creative-learning', title: 'Creative feedback loop', objective: 'Ensure the produced recipe can receive user feedback and later Instagram performance outcomes.', kind: 'integration', worker: 'coding', dependsOn: ['render-test'], acceptance: common },
    { id: 'media-review', title: 'Independent creative-system review', objective: 'Verify the feature is actually reusable by natural Ultron commands and not only by a test script.', kind: 'critic', worker: 'review', dependsOn: ['creative-learning'], acceptance: common },
  ];
  if (profile.id === 'full_product') return [
    { id: 'vertical-slice', title: 'Smallest complete vertical slice', objective: `Define the smallest end-to-end slice that proves the value of: ${objective}`, kind: 'product', worker: 'reasoning', dependsOn: [], acceptance: ['Scope is minimal but complete'] },
    { id: 'architecture', title: 'Lean architecture', objective: 'Design only the modules/data contracts required for the vertical slice and future extension.', kind: 'architect', worker: 'reasoning', dependsOn: ['vertical-slice'], acceptance: ['Avoid unnecessary infrastructure'] },
    { id: 'core', title: 'Core vertical-slice build', objective: 'Implement the complete core slice with runnable files and deterministic validation.', kind: 'backend', worker: 'coding', dependsOn: ['architecture'], acceptance: common },
    { id: 'integration', title: 'Integration pass', objective: 'Connect the slice to existing Ultron state, Operator Mode, Adaptive Intelligence and artifacts where relevant.', kind: 'integration', worker: 'coding', dependsOn: ['core'], acceptance: common },
    { id: 'qa', title: 'Critical-flow QA', objective: 'Test the actual founder/user flow, restart safety and failure paths.', kind: 'qa', worker: 'review', dependsOn: ['integration'], acceptance: common },
    { id: 'final-review', title: 'Independent final review', objective: 'Verify the promised vertical slice is usable and no claimed capability is merely scaffolded.', kind: 'critic', worker: 'review', dependsOn: ['qa'], acceptance: common },
  ];
  return [
    { id: 'feature-contract', title: 'Feature contract', objective: `Define exact behavior, integration points and regression boundaries for: ${objective}`, kind: 'product', worker: 'reasoning', dependsOn: [], acceptance: ['Existing behavior to preserve is explicit'] },
    { id: 'feature-build', title: 'Feature implementation', objective: 'Implement the feature in the existing codebase, reusing existing services instead of duplicating them.', kind: 'integration', worker: 'coding', dependsOn: ['feature-contract'], acceptance: common },
    { id: 'feature-qa', title: 'Feature regression QA', objective: 'Exercise the real user flow and relevant existing checks.', kind: 'qa', worker: 'review', dependsOn: ['feature-build'], acceptance: common },
  ];
}

function compilerGuidance(objective = '') {
  const profile = classify(objective);
  return [
    `FOUNDER FORGE PROFILE: ${profile.label} (${profile.id}).`,
    `PROFILE PRINCIPLE: ${profile.principle}`,
    `TARGET JOB COUNT: normally <= ${profile.maxJobs}; fewer is better when one coding job can safely do the work.`,
    'FOUNDER PREFERENCES: preserve working systems; avoid documentation-only jobs; prefer real implementation + verification; use deterministic/local tooling before spending free model quota; no local LLM; no paid fallback; keep external actions approval-gated; connect features to existing memory/state/operator/adaptive layers instead of creating isolated islands.',
  ].join(' ');
}

function applyCurrentModelPool(governor) {
  const pool = governor?.ROLE_MODELS;
  if (!pool) return false;
  for (const [role, models] of Object.entries(CURRENT_FREE_MODELS)) pool[role] = [...models];
  return true;
}

module.exports = { CURRENT_FREE_MODELS, PROFILES, classify, shouldDelegate, fallbackJobs, compilerGuidance, applyCurrentModelPool };
