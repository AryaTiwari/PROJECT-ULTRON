const prefs = require('../core/forge/preferences');
const compiler = require('../core/forge/mission-compiler');
const governor = require('../core/forge/model-governor');

function assert(condition, message) { if (!condition) throw new Error(message); }

assert(prefs.classify('fix the caption bug in Reel Factory').id === 'repair', 'Small Reel bug must route to focused repair, not media rebuild.');
assert(prefs.classify('connect Instagram publishing API with R2').id === 'integration', 'API connection must use integration profile.');
assert(prefs.classify('build Instagram DM lead operator for Elevate OS').id === 'creator_ops', 'Creator business operator must use creator_ops profile.');
assert(prefs.classify('build a durable follow-up automation with retries').id === 'automation', 'Durable workflow must use automation profile.');
assert(prefs.classify('improve Reel Factory video editing pipeline').id === 'media_pipeline', 'Reel pipeline work must use media profile.');
assert(!prefs.shouldDelegate('fix this one syntax bug in reel-operator-bootstrap.js'), 'Focused bug repair should stay with Coding Brain instead of opening Forge.');
assert(prefs.shouldDelegate('Forge build the complete Instagram DM operator'), 'Explicit Forge request must delegate.');
assert(prefs.shouldDelegate('connect Instagram publishing API with R2 and approval-gated posting'), 'Substantial integration should delegate to Forge.');

const integrationFallback = compiler.fallback('connect Instagram publishing API with R2');
assert(integrationFallback.forgeProfile === 'integration', 'Fallback compiler must preserve mission profile.');
assert(integrationFallback.jobs.length <= prefs.PROFILES.integration.maxJobs, 'Integration fallback must remain lean.');
assert(integrationFallback.jobs.some((job) => job.worker === 'coding'), 'Forge profile must include real implementation.');
assert(integrationFallback.jobs.some((job) => job.worker === 'review'), 'Forge profile must include independent verification.');

prefs.applyCurrentModelPool(governor);
const models = governor.status().roleModels.code_build;
assert(models.includes('deepseek-ai/deepseek-v4-flash-0731'), 'Current DeepSeek V4 Flash free fallback must be in Forge coding pool.');
assert(models.includes('nvidia/nemotron-3.5-lightning-30b-a3b'), 'Current Nemotron Lightning free fallback must be in Forge coding pool.');
assert(governor.status().zeroCostOnly === true && governor.status().paidFallbackAllowed === false, 'Forge must remain hard zero-cost only.');

console.log('ULTRON Forge Preferences self-test passed: focused repair routing, creator/integration/automation profiles, lean DAGs and refreshed zero-cost model pool validated.');
