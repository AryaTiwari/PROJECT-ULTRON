const fs = require('fs');
const path = require('path');
const turbo = require('../core/turbo-engine');
const turboBootstrap = require('../core/turbo-bootstrap');
const researchTurbo = require('../core/research-turbo-runtime');
const freeTools = require('../core/free-tool-registry');
const adaptive = require('../core/adaptive-intelligence');

function assert(condition, message) { if (!condition) throw new Error(message); }

assert(adaptive.extractPreference('I want the response style to be shorter and cleaner.')?.domain === 'communication', 'Adaptive qualitative I-want preference regression remains.');
assert(adaptive.extractPreference('I want you to create a Reel about creator growth.') === null, 'Normal action request must not become preference memory.');
assert(turboBootstrap.isTurboStatus('Ultron, audit yourself and tell me what is broken'), 'Natural Turbo health intent must route locally.');
assert(turboBootstrap.isFreeToolRequest('What free APIs should I add to Ultron?'), 'Natural free-tool discovery intent must route locally.');
assert(turboBootstrap.isTopologyRequest('Show me the Ultron integration map'), 'Natural topology intent must route locally.');

const registry = freeTools.status();
assert(registry.zeroCostOnly === true && registry.total >= 10, 'Turbo free-tool registry must remain zero-cost focused and non-trivial.');
assert(freeTools.byId('tavily')?.autoUse === 'fallback-only', 'Tavily must be fallback-only, not silently spend quota first.');
assert(freeTools.byId('resend')?.autoUse === 'approval-required', 'Email sending must remain approval-gated.');
assert(freeTools.byId('alpha-vantage')?.autoUse === 'research-paper-only', 'Market-data integration must preserve paper/research boundary.');

const status = researchTurbo.status();
assert(status.zeroCostOnly === true && status.primary === 'tinyfish/direct-http', 'Research Turbo must preserve current primary and zero-cost policy.');
const report = turbo.audit();
assert(report.zeroCostGuard.enabled === true && report.zeroCostGuard.paidInferenceAllowed === false, 'Turbo audit must expose hard paid-inference guard.');
assert(report.topology.some((edge) => edge.from === 'adaptive-intelligence' && edge.to === 'founder-behavior'), 'Adaptive preferences must appear in runtime topology.');
assert(report.topology.some((edge) => edge.from === 'reel-factory' && edge.to === 'reel-learning'), 'Reel creative learning loop must appear in runtime topology.');

const adaptiveSource = fs.readFileSync(path.resolve(__dirname, '../core/adaptive-intelligence.js'), 'utf8');
const observeBody = adaptiveSource.match(/function observeTurn[\s\S]*?\n}\n\nfunction topSignals/)?.[0] || '';
assert(!/resolveLatestProposal\s*\(/.test(observeBody), 'Generic conversation turns must not silently approve pending adaptive proposals.');

console.log('ULTRON Turbo self-test passed: adaptive safety, free-tool registry, research failover policy, runtime topology and zero-cost guard validated.');
