const fs = require('fs');
const path = require('path');
const conversation = require('../core/conversation');
const contextFabric = require('../core/context-fabric');
const contextRuntime = require('../core/context-fabric-runtime');
const greeting = require('../core/greeting');

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

const clock = contextFabric.clock(new Date('2026-09-07T04:30:00.000Z'));
assert(clock.timezone && clock.daypart, 'Context Fabric must expose local timezone and daypart.');
const compact = contextFabric.compactSnapshot();
assert(Array.isArray(compact.recentSessions), 'Context Fabric must expose recent persistent chat sessions.');
assert(Array.isArray(compact.features), 'Context Fabric must expose connected capability mesh.');
assert(compact.diagnostic && compact.diagnostic.text, 'Context Fabric must expose a diagnostic coaching suggestion.');

const injected = contextRuntime.inject([
  { role: 'system', content: 'SYSTEM BASE' },
  { role: 'user', content: 'What should we work on next?' },
]);
assert(/ULTRON SHARED CONTEXT FABRIC/i.test(injected[0].content), 'Shared context must be injected into normal model reasoning.');
assert(/continuous working partner/i.test(injected[0].content), 'Fluid conversation behavior must be part of the shared runtime instruction.');

const firstGreeting = greeting.choose('morning', 1);
const secondGreeting = greeting.choose('morning', 1);
assert(firstGreeting !== secondGreeting, 'Greeting module must avoid repeating the same greeting back-to-back.');

const preload = fs.readFileSync(path.resolve(__dirname, '../core/forge/preload.js'), 'utf8');
assert(/\/api\/context\/fabric/.test(preload), 'Context Fabric API must be exposed to the interface.');
assert(/\/api\/conversation\/history/.test(preload), 'Persistent chat-history API must be exposed to the interface.');
assert(/enrollment is paused|intentionally dormant/i.test(preload), 'Telegram must remain dormant rather than auto-starting.');

const contextUi = fs.readFileSync(path.resolve(__dirname, '../interface/context-ui.js'), 'utf8');
assert(/RECENT THREADS/.test(contextUi) && /CAPABILITY MESH/.test(contextUi), 'Interface must expose recent threads and connected capability mesh.');
assert(/\/api\/conversation\/history/.test(contextUi), 'Interface must restore transcript history from the persistent backend.');

console.log('ULTRON Continuity self-test passed: persistent sessions, time-aware context, varied greetings, shared feature awareness, diagnostics and history UI validated.');
