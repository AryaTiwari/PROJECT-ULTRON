const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const projectRoot = path.resolve(root, '..');
const required = [
  'server.js',
  'core/config.js',
  'core/persistence.js',
  'core/memory.js',
  'core/workspace.js',
  'core/model-intelligence.js',
  'core/model-league.js',
  'core/model-arena.js',
  'core/provider-registry.js',
  'core/direct-provider-router.js',
  'core/omniroute-fallback.js',
  'core/omniroute-lazy-hooks.js',
  'core/model-router.js',
  'core/planner.js',
  'core/verifier.js',
  'core/integrations.js',
  'core/tools.js',
  'core/web.js',
  'core/coding-brain.js',
  'core/coding-inference.js',
  'core/self-repository.js',
  'core/assistant.js',
  'core/assistant-handoff.js',
  'core/conversation.js',
  'core/proactive.js',
  'core/voice-orchestrator.js',
  'core/windows-voice.js',
  'scripts/start-mark3.mjs',
  'scripts/start-transport.mjs',
  'interface/index.html',
  'interface/style.css',
  'interface/chat-transport.js',
  'interface/app.js',
];
const sharedTransport = ['core/omniroute.js', 'core/voice/index.js', 'core/credentials/local-store.js'];

for (const rel of required) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) throw new Error(`Missing required Mark 3 file: ${rel}`);
}
for (const rel of sharedTransport) {
  const file = path.join(projectRoot, rel);
  if (!fs.existsSync(file)) throw new Error(`Missing shared transport file: ${rel}`);
}

const js = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (['node_modules', 'data', 'workspace', '.ultron'].includes(name)) continue;
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) walk(file);
    else if (/\.(js|cjs|mjs)$/.test(name)) js.push(file);
  }
}
walk(root);

const sharedJs = sharedTransport.filter((rel) => /\.(js|cjs|mjs)$/.test(rel)).map((rel) => path.join(projectRoot, rel));
for (const file of [...js, ...sharedJs]) {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' }); }
  catch {
    const label = file.startsWith(`${root}${path.sep}`) ? path.relative(root, file) : path.relative(projectRoot, file);
    throw new Error(`JavaScript syntax check failed: ${label}`);
  }
}

function hasRuntimeCoupling(text) {
  const startUnified = /(?:require\s*\(|import\s+[^;]*?from\s+|spawn\s*\([^,]+,\s*\[[^\]]*)['\"](?:\.\.\/)*scripts\/start-unified\.mjs['\"]/m;
  const parentCoreUsage = /\bconfig\.parentCore\b/;
  return startUnified.test(text) || parentCoreUsage.test(text);
}

for (const file of js) {
  const rel = path.relative(root, file);
  const text = fs.readFileSync(file, 'utf8');
  if (/github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}/.test(text)) throw new Error(`Possible secret embedded in source: ${rel}`);
  if (rel !== path.join('scripts', 'preflight.js') && hasRuntimeCoupling(text)) throw new Error(`Mark 2 runtime coupling detected in Mark 3 source: ${rel}`);
}

const packageFile = path.join(root, 'package.json');
if (fs.existsSync(packageFile)) {
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const start = String(pkg?.scripts?.start || '');
  if (/start-unified\.mjs/i.test(start)) throw new Error('Mark 3 package start script must not launch the Mark 2 unified runtime.');
  if (!/start-transport\.mjs/i.test(start)) throw new Error('Mark 3 startup must use the direct-first transport selector.');
  if (pkg.version !== '3.0.0-beta.19') throw new Error(`Unexpected Mark 3 package version: ${pkg.version}`);
}

const mark3Launcher = fs.readFileSync(path.join(root, 'scripts', 'start-mark3.mjs'), 'utf8');
if (/run-next\.mjs[^\n\r]*['\"]?\s*,?\s*['\"]dev['\"]?/i.test(mark3Launcher)) {
  throw new Error('Mark 3 must not launch OmniRoute through run-next.mjs dev during normal startup. Use the packaged production runtime.');
}
if (!/OMNIROUTE_MEMORY_MB/.test(mark3Launcher) || !/omniroute-production\.log/.test(mark3Launcher)) {
  throw new Error('Mark 3 OmniRoute launcher must keep the production low-memory runtime policy.');
}

const transportLauncher = fs.readFileSync(path.join(root, 'scripts', 'start-transport.mjs'), 'utf8');
if (!/Direct Gemini\/Groq\/NVIDIA credential pool detected/.test(transportLauncher) || !/lazy fallback/i.test(transportLauncher)) {
  throw new Error('Direct-provider startup must leave OmniRoute as a lazy fallback.');
}
if (!/GEMINI_API_KEY2/.test(transportLauncher) || !/GROQ_API_KEY2/.test(transportLauncher)) {
  throw new Error('Direct-provider startup must recognize secondary Gemini and Groq API keys.');
}
if (/detached:\s*true/.test(transportLauncher)) throw new Error('Direct-provider startup must not eagerly warm a detached OmniRoute process.');

const omniTransport = fs.readFileSync(path.join(projectRoot, 'core', 'omniroute.js'), 'utf8');
if (/message\.reasoning_content|delta\.reasoning_content/.test(omniTransport)) {
  throw new Error('Mark 3 transport must not surface hidden reasoning_content as visible assistant text.');
}

const interfaceJs = fs.readFileSync(path.join(root, 'interface', 'app.js'), 'utf8');
if (!/SpeechRecognition|webkitSpeechRecognition/.test(interfaceJs)) throw new Error('Voice-first interface must keep browser speech recognition.');
if (!/WAKE_WORD=['\"]ultron['\"]/.test(interfaceJs) || !/wakeMatch\s*\(/.test(interfaceJs)) throw new Error('Wake-word detection for Ultron is missing.');
if (!/COMMAND_SILENCE_MS=4000/.test(interfaceJs)) throw new Error('Voice command silence window must remain four seconds.');
if (!/createMediaElementSource/.test(interfaceJs) || !/createAnalyser/.test(interfaceJs) || !/speechEnergy/.test(interfaceJs)) throw new Error('Audio-reactive speaking visualization is missing.');
if (!/recognitionMode==='wake'/.test(interfaceJs) || !/recognitionMode==='command'/.test(interfaceJs)) throw new Error('Wake/command recognition state machine is missing.');
const chatTransport = fs.readFileSync(path.join(root, 'interface', 'chat-transport.js'), 'utf8');
if (!/10\s*\*\s*60\s*\*\s*1000/.test(chatTransport) || !/api\\\/chat|api\/chat/.test(chatTransport)) throw new Error('Chat transport must override the legacy 120-second UI cancellation with the managed long-task ceiling.');

const config = require('../core/config');
const registry = require('../core/provider-registry');
const direct = require('../core/direct-provider-router');
const omniFallback = require('../core/omniroute-fallback');
const router = require('../core/model-router');
const league = require('../core/model-league');
const arena = require('../core/model-arena');
const conversation = require('../core/conversation');
const web = require('../core/web');
const codingBrain = require('../core/coding-brain');
const codingInference = require('../core/coding-inference');
const integrations = require('../core/integrations');
const selfRepository = require('../core/self-repository');
const handoff = require('../core/assistant-handoff');

// The shared root OmniRoute module still reads this selector, but Mark 3 routes direct APIs above it.
if (process.env.ULTRON_MODEL_PROVIDER !== 'omniroute') throw new Error('Shared OmniRoute compatibility selector must remain omniroute.');
if (config.disableNvidiaInference !== false) throw new Error('NVIDIA direct inference must remain enabled.');
if (!config.voiceOutputDir.startsWith(config.projectRoot)) throw new Error('Mark 3 voice output must be anchored to the project root.');
if (!config.modelLeaguePath.startsWith(config.dataDir)) throw new Error('Model League state must live under Mark 3 data.');
if (!/^https?:\/\/127\.0\.0\.1:8791|^https?:\/\/localhost:8791/i.test(config.codingBrainUrl) && !process.env.ULTRON_M3_CODING_BRAIN_URL) throw new Error('Coding Brain should default to the local sidecar endpoint.');
if (registry.policyAllows('cloudflare-playground') && !/^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_ALLOW_EXPERIMENTAL_PROVIDERS || ''))) throw new Error('Experimental browser/CLI providers must be disabled by default.');
if (!registry.PROVIDERS.nvidia || registry.PROVIDERS.nvidia.tier !== 'api') throw new Error('NVIDIA must be a first-class API provider.');
if (!registry.PROVIDERS.gemini.credentials.includes('GEMINI_API_KEY2') || !registry.PROVIDERS.groq.credentials.includes('GROQ_API_KEY2')) throw new Error('Provider registry must recognize secondary Gemini/Groq credentials.');
if (typeof direct.chat !== 'function' || typeof direct.streamChat !== 'function' || typeof direct.candidates !== 'function' || typeof direct.health !== 'function' || typeof direct.credentialPool !== 'function') throw new Error('Multi-key direct-provider router API is incomplete.');
if (!direct.PROVIDERS.gemini.keys.includes('GEMINI_API_KEY2') || !direct.PROVIDERS.groq.keys.includes('GROQ_API_KEY2')) throw new Error('Direct provider key pools are missing KEY2 slots.');
if (direct.providerOrder('simple_qa')[0] !== 'groq') throw new Error('Simple Q&A must prefer Groq for low latency.');
if (direct.providerOrder('coding')[0] !== 'nvidia' || direct.providerOrder('planning')[0] !== 'nvidia') throw new Error('Coding/planning must prefer NVIDIA specialist models.');
if (direct.providerOrder('research')[0] !== 'gemini') throw new Error('Research must prefer Gemini.');
if (!direct.isDirectModel('gemini/gemini-test') || !direct.isDirectModel('groq/model/test') || !direct.isDirectModel('nvidia/openai/gpt-oss-120b')) throw new Error('Direct Gemini/Groq/NVIDIA model parsing is incomplete.');
if (router.isBlockedModel('nvidia/openai/gpt-oss-120b')) throw new Error('NVIDIA direct inference is still blocked by router policy.');
if (typeof omniFallback.ensure !== 'function' || omniFallback.status().mode !== 'lazy-fallback') throw new Error('Lazy OmniRoute fallback API is incomplete.');
if (typeof router.chatExact !== 'function' || typeof router.streamExact !== 'function' || typeof router.listNativeEligibleModels !== 'function') throw new Error('Model League requires exact-model router primitives.');
if (typeof league.recommend !== 'function' || typeof league.selectParticipants !== 'function' || typeof league.directConfigured !== 'function' || typeof league.isDirectModel !== 'function') throw new Error('Adaptive direct-only Model League API is incomplete.');
if (!league.isDirectModel('gemini/gemini-test') || league.isDirectModel('anthropic/claude-test')) throw new Error('Model League direct-model filter is invalid.');
if (typeof arena.runTournament !== 'function' || typeof arena.start !== 'function') throw new Error('Model Arena API is incomplete.');
if (typeof codingBrain.run !== 'function' || typeof codingBrain.health !== 'function' || typeof codingBrain.shouldUse !== 'function') throw new Error('Coding Brain bridge API is incomplete.');
if (!codingBrain.shouldUse('Fix the wake-word bug in the interface', 'coding')) throw new Error('Repository implementation tasks must route to Coding Brain.');
if (codingBrain.shouldUse('What is a JavaScript closure?', 'coding')) throw new Error('Simple coding questions must not invoke the heavyweight Coding Brain.');
if (codingBrain.modeFor('Inspect the wake-word implementation') !== 'plan') throw new Error('Read-only coding investigation must use plan mode.');
if (codingBrain.modeFor('Fix the wake-word implementation') !== 'apply') throw new Error('Explicit coding modifications must use apply mode.');
if (codingInference.roleTaskType('editor') !== 'coding' || codingInference.roleTaskType('reviewer') !== 'planning') throw new Error('Coding Brain role-to-model routing is invalid.');
if (typeof integrations.githubSelfStatus !== 'function') throw new Error('Deterministic self-GitHub status API is missing.');
if (!selfRepository.isSelfRepositoryStatusIntent('Ultron can you check your own get hub and tell me whether there is a new update')) throw new Error('Voice-transcribed self-GitHub update intent must use the deterministic fast path.');
if (!conversation.isContinuation('finish it now')) throw new Error('Failed-task continuation phrase “finish it now” must preserve prior context.');
if (!selfRepository.continuationTargetsSelfRepository('finish it now', [{ role:'user', content:'Check your own GitHub and tell me whether there is a new update.' }])) throw new Error('Self-GitHub task must survive a finish-it-now continuation.');
if (!/next command/i.test(handoff.withCommandHandoff('Done.'))) throw new Error('Assistant command handoff must remain active for ordinary responses.');
if (handoff.withCommandHandoff('What should I do next?') !== 'What should I do next?') throw new Error('Assistant handoff must not duplicate an existing follow-up question.');
if (conversation.contextFor('hey ultron', [{ role:'assistant', content:'Old unrelated task' }]).length) throw new Error('Greeting context isolation invariant failed.');
if (web.normalizeUrl('www.elevateos.in').hostname !== 'www.elevateos.in') throw new Error('Public web URL normalization invariant failed.');
if (web.status().primary !== 'tinyfish') throw new Error('TinyFish must be the primary Mark 3 web provider.');
if (!web.status().configured) console.warn('[Mark 3] TinyFish warning: TINYFISH_API_KEY was not detected; URL fetch will use direct fallback and live web search will be unavailable.');
else console.log('[Mark 3] TinyFish web layer configured: Fetch + Search enabled.');

console.log(`ULTRON Mark 3 preflight passed: ${required.length} Mark 3 files, ${sharedTransport.length} shared transport files and ${js.length + sharedJs.length} JavaScript files validated.`);
