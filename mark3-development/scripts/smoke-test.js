const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const files = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (['node_modules', 'data', 'workspace', '.ultron'].includes(name)) continue;
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) walk(file);
    else if (/\.(js|cjs|mjs)$/.test(name)) files.push(file);
  }
}
walk(root);
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });

const memory = require('../core/memory');
const planner = require('../core/planner');
const voice = require('../core/voice-orchestrator');
const router = require('../core/model-router');
const windowsVoice = require('../core/windows-voice');

if (memory.similarity('hello world', 'hello world') < 0.99) throw new Error('Memory similarity invariant failed.');
if (!planner.createPlan('read a GitHub repository file', 'coding').steps.length) throw new Error('Planner invariant failed.');
if (voice.splitSpeech('Hello. How are you? I am ready!').length !== 3) throw new Error('Voice sentence segmentation invariant failed.');
if (windowsVoice.cleanSpeechText('Hello `code` https://example.com').includes('https://')) throw new Error('Windows voice cleanup invariant failed.');
if (!router.isBlockedModel('nvidia/some-model')) throw new Error('NVIDIA inference must be blocked in Mark 3.');
if (!router.isBlockedModel('opencode/big-pickle')) throw new Error('OpenCode/Big Pickle inference must be blocked in Mark 3.');
if (!router.isBlockedModel('dva/swe-1-7-lightning')) throw new Error('Devin bridge models must not enter normal assistant chat.');
if (router.normalizeRequestedModel('auto/best-fast') !== 'auto') throw new Error('Routing aliases must resolve through Mark 3 live routing.');

console.log(`ULTRON Mark 3 smoke test passed: ${files.length} JS files checked.`);
