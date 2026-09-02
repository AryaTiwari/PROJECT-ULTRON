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
const registry = require('../core/provider-registry');
const conversation = require('../core/conversation');
const web = require('../core/web');
const windowsVoice = require('../core/windows-voice');

if (memory.similarity('hello world', 'hello world') < 0.99) throw new Error('Memory similarity invariant failed.');
if (!planner.createPlan('read a GitHub repository file', 'coding').steps.length) throw new Error('Planner invariant failed.');
if (voice.splitSpeech('Hello. How are you? I am ready!').length !== 3) throw new Error('Voice sentence segmentation invariant failed.');
if (windowsVoice.cleanSpeechText('Hello `code` https://example.com').includes('https://')) throw new Error('Windows voice cleanup invariant failed.');
if (!router.isBlockedModel('nvidia/some-model')) throw new Error('NVIDIA inference must be blocked in Mark 3.');
if (!router.isBlockedModel('opencode/big-pickle')) throw new Error('OpenCode/Big Pickle inference must be blocked in Mark 3.');
if (!router.isBlockedModel('dva/swe-1-7-lightning')) throw new Error('Devin bridge models must not enter normal assistant chat.');
if (router.normalizeRequestedModel('auto/best-fast') !== 'auto') throw new Error('Routing aliases must resolve through Mark 3 live routing.');
if (registry.providerFromModel('gemini-3.1-flash-lite') !== 'gemini') throw new Error('Bare Gemini model IDs must resolve to the Gemini provider.');
if (registry.providerFromModel('claude-sonnet-4') !== 'anthropic') throw new Error('Bare Claude model IDs must resolve to Anthropic.');
if (!router.nativeProviderAllowed('meta')) throw new Error('Native OmniRoute must accept legitimate providers not listed in the managed fallback registry.');
if (!router.nativeProviderAllowed('cerebras')) throw new Error('Native OmniRoute must remain forward-compatible with new provider names.');
if (router.nativeProviderAllowed('cloudflare-playground')) throw new Error('Known experimental browser/CLI providers must remain blocked from native assistant inference.');

const fakeHistory = [
  { role: 'user', content: 'Review my Elevate website.' },
  { role: 'assistant', content: 'Send me the URL.' },
];
if (conversation.contextFor('hey ultron', fakeHistory).length !== 0) throw new Error('Greetings must not inherit old conversation context.');
if (conversation.contextFor('www.elevateos.in', fakeHistory).length !== 2) throw new Error('Bare URLs must preserve immediate continuation context.');
if (conversation.contextFor('Explain quantum tunneling', fakeHistory).length !== 0) throw new Error('Unrelated new topics must not inherit old conversation context.');
if (web.normalizeUrl('www.elevateos.in').hostname !== 'www.elevateos.in') throw new Error('Web URL normalization invariant failed.');
if (web.extractFirstUrl('Review www.elevateos.in please') !== 'www.elevateos.in') throw new Error('Web URL extraction invariant failed.');
const elevateVariants = web.urlVariants('www.elevateos.in');
if (elevateVariants.length !== 2 || elevateVariants[1].hostname !== 'elevateos.in') throw new Error('WWW URLs must generate an apex-domain retry for remote web fetching.');
if (!web.status().remoteDns || !web.status().canonicalHostRetry) throw new Error('TinyFish must remain remote-DNS-first with canonical host retry enabled.');
if (!web.shouldSearch('Search the web for the latest Gemini updates')) throw new Error('Explicit live-web search intent must trigger TinyFish Search.');
if (web.shouldSearch('Explain how transformers work')) throw new Error('Evergreen questions must not trigger unnecessary web search.');
if (web.status().primary !== 'tinyfish') throw new Error('TinyFish must remain the primary web provider.');

console.log(`ULTRON Mark 3 smoke test passed: ${files.length} JS files checked.`);
