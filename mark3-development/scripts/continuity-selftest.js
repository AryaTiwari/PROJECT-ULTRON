const fs = require('fs');
const path = require('path');
const conversation = require('../core/conversation');
const contextFabric = require('../core/context-fabric');
const contextRuntime = require('../core/context-fabric-runtime');
const greeting = require('../core/greeting');
const activity = require('../core/activity-fabric');
const registry = require('../core/free-tool-registry');

function assert(condition, message) { if (!condition) throw new Error(message); }

const base = Date.now() - 3 * 60 * 60 * 1000;
const fixture = [
  { role: 'user', content: 'Fix Reel Factory captions', at: new Date(base).toISOString() },
  { role: 'assistant', content: 'Caption system fixed.', at: new Date(base + 60000).toISOString() },
  { role: 'user', content: 'Now improve the interface', at: new Date(base + conversation.SESSION_GAP_MS + 120000).toISOString() },
  { role: 'assistant', content: 'Interface pass started.', at: new Date(base + conversation.SESSION_GAP_MS + 180000).toISOString() },
];
const sessions = conversation.sessionize(fixture);
assert(sessions.length === 2, 'Conversation history must split persistent sessions across the configured session gap.');
assert(/Fix Reel Factory captions/i.test(sessions[0].title), 'Session title must preserve the first user objective.');
assert(/improve the interface/i.test(sessions[1].lastUser), 'Session summary must preserve the latest user request.');

const normalized = activity.normalize({ type: 'reel_factory_completed', brief: 'Creator growth reel', at: new Date().toISOString() });
assert(normalized.source === 'reel' && normalized.status === 'done', 'Cross-feature activity must normalize Reel completion into shared context.');

const clock = contextFabric.clock(new Date('2026-09-07T04:30:00.000Z'));
assert(clock.timezone && clock.daypart, 'Context Fabric must expose local timezone and daypart.');
const compact = contextFabric.compactSnapshot();
assert(Array.isArray(compact.recentSessions), 'Context Fabric must expose recent persistent chat sessions.');
assert(Array.isArray(compact.features), 'Context Fabric must expose connected capability mesh.');
assert(Array.isArray(compact.recentActivity), 'Context Fabric must expose recent cross-feature activity.');
assert(compact.diagnostic && compact.diagnostic.text, 'Context Fabric must expose a diagnostic coaching suggestion.');

const injected = contextRuntime.inject([
  { role: 'system', content: 'SYSTEM BASE' },
  { role: 'user', content: 'What should we work on next?' },
]);
assert(/ULTRON SHARED CONTEXT FABRIC/i.test(injected[0].content), 'Shared context must be injected into normal model reasoning.');
assert(/continuous working partner/i.test(injected[0].content), 'Fluid conversation behavior must be part of the shared runtime instruction.');
assert(/CROSS-FEATURE RULE/i.test(injected[0].content), 'Normal reasoning must explicitly connect enrolled features instead of treating them as islands.');

const firstGreeting = greeting.choose('morning', 1);
const secondGreeting = greeting.choose('morning', 1);
assert(firstGreeting !== secondGreeting, 'Greeting module must avoid repeating the same greeting back-to-back.');

const preload = fs.readFileSync(path.resolve(__dirname, '../core/forge/preload.js'), 'utf8');
assert(/\/api\/context\/fabric/.test(preload), 'Context Fabric API must be exposed to the interface.');
assert(/\/api\/context\/greeting/.test(preload), 'Startup greeting API must be exposed to the interface.');
assert(/\/api\/context\/activity/.test(preload), 'Cross-feature activity API must be exposed to the interface.');
assert(/\/api\/conversation\/history/.test(preload), 'Persistent chat-history API must be exposed to the interface.');
assert(/enrollment is paused|intentionally dormant/i.test(preload), 'Telegram must remain dormant rather than auto-starting.');

const contextUi = fs.readFileSync(path.resolve(__dirname, '../interface/context-ui.js'), 'utf8');
assert(/RECENT THREADS/.test(contextUi) && /CAPABILITY MESH/.test(contextUi), 'Interface must expose recent threads and connected capability mesh.');
assert(/ACTIVITY FABRIC/.test(contextUi), 'Interface must expose the shared cross-feature activity trail.');
assert(/\/api\/conversation\/history/.test(contextUi), 'Interface must restore transcript history from the persistent backend.');
assert(/\/api\/context\/greeting/.test(contextUi), 'Interface must show a contextual startup greeting.');

const historyBridge = fs.readFileSync(path.resolve(__dirname, '../interface/history-bridge.js'), 'utf8');
assert(/continuedSessionId/.test(historyBridge) && /selectedHistory/.test(historyBridge), 'Opening an earlier thread must carry that thread into the next chat request, not only redraw the UI.');
const bridgeHasSessionRoute = historyBridge.includes('\\/api\\/conversation\\/session') || historyBridge.includes('/api/conversation/session');
const bridgeHasChatRoute = historyBridge.includes('\\/api\\/chat') || historyBridge.includes('/api/chat');
assert(bridgeHasSessionRoute && bridgeHasChatRoute, 'History bridge must connect restored sessions to subsequent chat requests.');
assert(/history:\s*selectedHistory/.test(historyBridge) && /continuedSessionId:\s*selectedSessionId/.test(historyBridge), 'History bridge must inject the restored transcript and session identity into the next request.');

const interfaceIndex = fs.readFileSync(path.resolve(__dirname, '../interface/index.html'), 'utf8');
assert(/history-bridge\.js/.test(interfaceIndex), 'The browser interface must actually load the restored-thread history bridge.');

const ids = registry.TOOLS.map((row) => row.id);
assert(!ids.includes('youtube-data'), 'YouTube must remain removed until explicitly re-enrolled.');
assert(ids.includes('buffer') && ids.includes('tavily') && ids.includes('firecrawl'), 'Current enrolled integrations must remain in the clean registry.');
assert(registry.byId('telegram-bot')?.dormant === true, 'Telegram code must remain installed but dormant.');

console.log('ULTRON Continuity self-test passed: persistent sessions, continuable restored threads, time-aware varied greetings, cross-feature activity, shared capability awareness, diagnostics, clean tool enrollment and history UI validated.');