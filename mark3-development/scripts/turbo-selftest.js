const fs = require('fs');
const path = require('path');
const turbo = require('../core/turbo-engine');
const turboBootstrap = require('../core/turbo-bootstrap');
const researchTurbo = require('../core/research-turbo-runtime');
const freeTools = require('../core/free-tool-registry');
const adaptive = require('../core/adaptive-intelligence');
const operator = require('../core/operator');
const forgePreferences = require('../core/forge/preferences');
const contextFabric = require('../core/context-fabric');
const activity = require('../core/activity-fabric');

function assert(condition, message) { if (!condition) throw new Error(message); }

assert(adaptive.extractPreference('I want the response style to be shorter and cleaner.')?.domain === 'communication', 'Adaptive qualitative I-want preference regression remains.');
assert(adaptive.extractPreference('I want you to create a Reel about creator growth.') === null, 'Normal action request must not become preference memory.');
assert(turboBootstrap.isTurboStatus('Ultron, audit yourself and tell me what is broken'), 'Natural Turbo health intent must route locally.');
assert(turboBootstrap.isFreeToolRequest('What free APIs should I add to Ultron?'), 'Natural integration status intent must route locally.');
assert(turboBootstrap.isTopologyRequest('Show me the Ultron integration map'), 'Natural topology intent must route locally.');

const registry = freeTools.status();
assert(registry.zeroCostOnly === true && registry.total >= 5 && registry.total <= 8, 'Turbo integration registry must stay lean and represent the enrolled system.');
assert(freeTools.byId('tavily')?.autoUse === 'fallback-only', 'Tavily must be fallback-only, not silently spend quota first.');
assert(freeTools.byId('firecrawl')?.autoUse === 'fallback-only', 'Firecrawl must remain an extraction fallback.');
assert(freeTools.byId('buffer')?.implemented === true && freeTools.byId('buffer')?.autoUse === 'explicit-feature', 'Buffer connector foundation must remain implemented and explicit-use only.');
assert(freeTools.byId('pexels')?.implemented === true, 'Pexels must be represented as an enrolled Reel source.');
assert(freeTools.byId('telegram-bot')?.dormant === true && freeTools.byId('telegram-bot')?.ready === false, 'Telegram code must remain installed but dormant until founder enrollment.');
assert(freeTools.byId('youtube-data') === null, 'Deferred YouTube integration must not remain in the active registry.');

const status = researchTurbo.status();
assert(status.zeroCostOnly === true && status.primary === 'tinyfish/direct-http', 'Research Turbo must preserve current primary and zero-cost policy.');
assert(Array.isArray(status.fetchFallbacks) && status.fetchFallbacks[0] === 'jina-reader', 'No-key Jina Reader must remain the first extraction fallback.');
assert(!status.searchFallbacks.includes('brave'), 'Removed Brave fallback must not survive in runtime routing.');

const normalizedActivity = activity.normalize({ type: 'reel_factory_completed', brief: 'Test Reel' });
assert(normalizedActivity.source === 'reel' && normalizedActivity.status === 'done', 'Activity Fabric must classify feature events for cross-system awareness.');

const report = turbo.audit();
assert(report.zeroCostGuard.enabled === true && report.zeroCostGuard.paidInferenceAllowed === false, 'Turbo audit must expose hard paid-inference guard.');
assert(report.topology.some((edge) => edge.from === 'conversation-history' && edge.to === 'context-fabric'), 'Persistent conversation history must feed Context Fabric.');
assert(report.topology.some((edge) => edge.from === 'activity-fabric' && edge.to === 'context-fabric'), 'Cross-feature Activity Fabric must feed Context Fabric.');
assert(report.topology.some((edge) => edge.from === 'context-fabric' && edge.to === 'assistant'), 'Context Fabric must feed normal assistant reasoning.');
assert(report.topology.some((edge) => edge.from === 'reel-factory' && edge.to === 'reel-learning'), 'Reel creative learning loop must appear in runtime topology.');
assert(report.topology.some((edge) => edge.from === 'forge-founder-recipes' && edge.to === 'mission-compiler'), 'Founder recipes must appear in runtime topology.');
assert(report.topology.some((edge) => edge.from === 'buffer' && edge.to === 'social-publishing'), 'Buffer publishing foundation must appear in runtime topology.');
assert((report.forgeRecipes || []).includes('instagram-dm-sales') && (report.forgeRecipes || []).includes('cup-operator'), 'Turbo audit must surface founder-specific Forge recipes.');
assert(forgePreferences.founderRecipes.RECIPES.length >= 8, 'Founder automation recipe library must remain substantial.');

const compact = contextFabric.compactSnapshot();
assert(compact.clock?.timezone === 'Asia/Kolkata' || Boolean(compact.clock?.timezone), 'Context Fabric must expose an explicit local timezone.');
assert(Array.isArray(compact.recentSessions), 'Context Fabric must expose recent chat sessions.');
assert(Array.isArray(compact.features), 'Context Fabric must expose connected feature mesh.');
assert(Array.isArray(compact.recentActivity), 'Context Fabric must expose shared feature activity.');

const op = operator.summary();
assert(op.ready.some((row) => row.id === 'system_audit'), 'System audit must be a first-class ready operator.');
assert(op.ready.some((row) => row.id === 'adaptive_operator'), 'Adaptive Intelligence must be a first-class ready operator.');

const adaptiveSource = fs.readFileSync(path.resolve(__dirname, '../core/adaptive-intelligence.js'), 'utf8');
const observeBody = adaptiveSource.match(/function observeTurn[\s\S]*?\n}\n\nfunction topSignals/)?.[0] || '';
assert(!/resolveLatestProposal\s*\(/.test(observeBody), 'Generic conversation turns must not silently approve pending adaptive proposals.');

console.log('ULTRON Turbo self-test passed: lean integrations, Context/Activity Fabric continuity, founder Forge recipes, research failover and zero-cost guard validated.');
