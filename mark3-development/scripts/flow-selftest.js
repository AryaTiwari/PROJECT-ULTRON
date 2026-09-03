const fs = require('fs');
const path = require('path');
const operatingModes = require('../core/operating-modes');
const founderBehavior = require('../core/founder-behavior');
const gitPublisher = require('../core/git-publisher');

const root = path.resolve(__dirname, '..');
const wakeBoost = fs.readFileSync(path.join(root, 'interface', 'wake-boost.js'), 'utf8');
const chatTransport = fs.readFileSync(path.join(root, 'interface', 'chat-transport.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'interface', 'index.html'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(operatingModes.normalize('sales strategist') === 'sales', 'Sales strategist alias failed.');
assert(operatingModes.normalize('trading') === 'trader', 'Trader alias failed.');
assert(operatingModes.normalize('creator strategist') === 'influencer', 'Influencer strategist alias failed.');
assert(operatingModes.normalize('dev') === 'developer', 'Developer alias failed.');
assert(operatingModes.detectCommand('Ultron go developer mode')?.mode === 'developer', 'Voice-style developer mode command was not detected.');
assert(operatingModes.detectCommand('switch to sales strategist mode')?.mode === 'sales', 'Sales mode switch command was not detected.');

const originalMode = operatingModes.status().mode;
try {
  operatingModes.setMode('developer', 'selftest');
  assert(operatingModes.routeTask('fix the wake word', 'general') === 'coding', 'Developer mode must route implementation work to coding.');
  const messages = founderBehavior.apply([
    { role: 'system', content: 'You are ULTRON Mark 3, a persistent personal operating assistant.' },
    { role: 'user', content: 'Fix the wake word in your repository.' },
  ]);
  assert(/ACTIVE OPERATING MODE: DEVELOPER/.test(String(messages[0]?.content || '')), 'Developer operating prompt was not injected into ULTRON behavior.');
} finally {
  operatingModes.setMode(originalMode || 'executive', 'selftest-restore');
}

assert(gitPublisher.shouldPublish('Implement this and push it to GitHub.'), 'Explicit GitHub push intent must enable verified publication.');
assert(gitPublisher.shouldPublish('Fix it and commit it.'), 'Explicit commit intent must enable verified publication.');
assert(!gitPublisher.shouldPublish('Fix this bug locally.'), 'Local coding tasks must not silently publish.');

assert(/Math\.max\(5/.test(wakeBoost), 'Wake booster must request at least five recognition alternatives.');
assert(/fuzzyDistance:\s*2/.test(wakeBoost), 'Wake booster fuzzy-distance policy is missing.');
assert(/prematureFastFinalize:\s*false/.test(wakeBoost), 'Premature fast-finalization must stay disabled.');
assert(/commandTranscript:\s*['"]raw-confidence-ranked['"]/.test(wakeBoost), 'Command speech must preserve raw recognition text.');
assert(/locale:\s*['"]en-IN['"]/.test(wakeBoost), 'Indian-English recognition locale must remain enabled.');
assert(!/FAST_FINAL_SILENCE_MS/.test(wakeBoost), 'Fast-finalize timer must not return; it can cut speech mid-command.');
assert(/FLOW_REPLY_WINDOW_MS\s*=\s*8000/.test(chatTransport), 'Voice conversation flow must remain open for eight seconds.');
assert(/PLAYBACK_SETTLE_MS\s*=\s*700/.test(chatTransport), 'Conversation flow must wait for stable browser playback completion.');
assert(/voiceSynthesisComplete/.test(chatTransport) && /playbackSettled\(\)/.test(chatTransport), 'Flow must wait for TTS synthesis and playback completion before reopening the mic.');
assert(/lastChatInputMode\s*===\s*['"]voice['"]/.test(chatTransport), 'Wake-free flow must be tied to voice-originated conversation turns.');

const wakeIndex = indexHtml.indexOf('wake-boost.js');
const appIndex = indexHtml.indexOf('app.js');
assert(wakeIndex >= 0 && appIndex > wakeIndex, 'wake-boost.js must load before app.js.');

console.log('ULTRON interaction self-test passed: fuzzy wake, raw command capture, patient finalization, playback-safe 8s flow, specialist modes and explicit Git publishing validated.');
