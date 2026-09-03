const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const projectRoot = path.resolve(root, '..');
const required = [
  'server.js','core/config.js','core/persistence.js','core/memory.js','core/workspace.js','core/model-intelligence.js','core/model-league.js','core/model-arena.js',
  'core/provider-registry.js','core/direct-provider-router.js','core/omniroute-fallback.js','core/omniroute-lazy-hooks.js','core/model-router.js','core/integrations.js','core/founder-behavior.js',
  'core/tools.js','core/web.js','core/research-agent.js','core/coding-brain.js','core/coding-inference.js','core/self-repository.js','core/assistant.js','core/assistant-handoff.js','core/conversation.js',
  'core/voice-orchestrator.js','core/operating-modes.js','core/git-publisher.js','core/archive.js','core/document-renderer.js','core/file-vault.js','core/multimodal.js','core/native-voice-input.js',
  'scripts/start-mark3.mjs','scripts/start-transport.mjs','scripts/flow-selftest.js','scripts/research-selftest.js','scripts/routing-selftest.js','scripts/multimodal-selftest.js',
  'interface/index.html','interface/style.css','interface/multimodal.css','interface/chat-transport.js','interface/wake-boost.js','interface/app.js','interface/native-voice.js','interface/multimodal-ui.js',
];
const sharedTransport = ['core/omniroute.js','core/voice/index.js','core/credentials/local-store.js'];

for (const rel of required) if (!fs.existsSync(path.join(root, rel))) throw new Error(`Missing required Mark 3 file: ${rel}`);
for (const rel of sharedTransport) if (!fs.existsSync(path.join(projectRoot, rel))) throw new Error(`Missing shared transport file: ${rel}`);

const js = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (['node_modules','data','workspace','.ultron'].includes(name)) continue;
    const file = path.join(dir,name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) walk(file);
    else if (/\.(?:js|cjs|mjs)$/.test(name)) js.push(file);
  }
}
walk(root);
const sharedJs = sharedTransport.filter((rel)=>/\.(?:js|cjs|mjs)$/.test(rel)).map((rel)=>path.join(projectRoot,rel));
for (const file of [...js,...sharedJs]) {
  try { execFileSync(process.execPath,['--check',file],{stdio:'inherit'}); }
  catch { throw new Error(`JavaScript syntax check failed: ${file.startsWith(root)?path.relative(root,file):path.relative(projectRoot,file)}`); }
}

function actualMark2Coupling(text) {
  return /(?:require\s*\(|import\s+[^;]*?from\s+|spawn\s*\([^,]+,\s*\[[^\]]*)['\"](?:\.\.\/)*scripts\/start-unified\.mjs['\"]/m.test(text) || /\bconfig\.parentCore\b/.test(text);
}
for (const file of js) {
  const rel = path.relative(root,file);
  const text = fs.readFileSync(file,'utf8');
  if (/github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}/.test(text)) throw new Error(`Possible secret embedded in source: ${rel}`);
  if (rel !== path.join('scripts','preflight.js') && actualMark2Coupling(text)) throw new Error(`Mark 2 runtime coupling detected: ${rel}`);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
if (pkg.version !== '3.0.0-beta.22') throw new Error(`Unexpected Mark 3 package version: ${pkg.version}`);
const startScript = String(pkg?.scripts?.start||'');
if (/start-unified\.mjs/i.test(startScript)) throw new Error('Mark 3 start must not launch Mark 2.');
if (!/start-transport\.mjs/.test(startScript) || !/multimodal-selftest\.js/.test(startScript)) throw new Error('Mark 3 start must validate multimodal runtime and use transport selector.');

const mark3Launcher = fs.readFileSync(path.join(root,'scripts','start-mark3.mjs'),'utf8');
// Mentions of source dev mode in error messages/diagnostics are allowed. Only reject an actual
// direct run-next.mjs dev invocation in the launcher.
if (/spawn\s*\([^\n]+run-next\.mjs[^\n]+['\"]dev['\"]/i.test(mark3Launcher)) throw new Error('Normal Mark 3 startup must not launch OmniRoute source dev mode.');
if (!/OMNIROUTE_MEMORY_MB/.test(mark3Launcher) || !/omniroute-production\.log/.test(mark3Launcher)) throw new Error('OmniRoute production low-memory policy is missing.');
const transportLauncher = fs.readFileSync(path.join(root,'scripts','start-transport.mjs'),'utf8');
if (!/Direct Gemini\/Groq\/NVIDIA credential pool detected/.test(transportLauncher) || !/lazy fallback/i.test(transportLauncher)) throw new Error('Direct-first + lazy OmniRoute startup policy is missing.');
if (!/GEMINI_API_KEY2/.test(transportLauncher) || !/GROQ_API_KEY2/.test(transportLauncher)) throw new Error('Secondary direct API credentials are not detected.');

const rootOmni = fs.readFileSync(path.join(projectRoot,'core','omniroute.js'),'utf8');
if (/message\.reasoning_content|delta\.reasoning_content/.test(rootOmni)) throw new Error('Hidden model reasoning must not be surfaced.');
const appJs = fs.readFileSync(path.join(root,'interface','app.js'),'utf8');
const wakeBoost = fs.readFileSync(path.join(root,'interface','wake-boost.js'),'utf8');
const chatTransport = fs.readFileSync(path.join(root,'interface','chat-transport.js'),'utf8');
const nativeVoiceUi = fs.readFileSync(path.join(root,'interface','native-voice.js'),'utf8');
const multimodalUi = fs.readFileSync(path.join(root,'interface','multimodal-ui.js'),'utf8');
const indexHtml = fs.readFileSync(path.join(root,'interface','index.html'),'utf8');
const serverSource = fs.readFileSync(path.join(root,'server.js'),'utf8');
if (!/SpeechRecognition|webkitSpeechRecognition/.test(appJs) || !/WAKE_WORD=['\"]ultron['\"]/.test(appJs) || !/COMMAND_SILENCE_MS=4000/.test(appJs)) throw new Error('Patient wake/command recognition is missing.');
if (!/prematureFastFinalize:\s*false/.test(wakeBoost)) throw new Error('Premature voice finalization must remain disabled.');
if (!/FLOW_REPLY_WINDOW_MS\s*=\s*10000/.test(chatTransport) || !/PLAYBACK_SETTLE_MS\s*=\s*700/.test(chatTransport)) throw new Error('Playback-safe ten-second flow is missing.');
if (!/MediaRecorder/.test(nativeVoiceUi) || !/\/api\/voice\/transcribe/.test(nativeVoiceUi) || !/browserTranscript/.test(nativeVoiceUi)) throw new Error('Native-audio command path is missing.');
if (!/\/api\/files\/upload/.test(multimodalUi) || !/attachments/.test(multimodalUi) || !/artifacts/.test(multimodalUi)) throw new Error('Attachment/artifact UI is incomplete.');
if (!/multimodal\.css/.test(indexHtml) || !/native-voice\.js/.test(indexHtml) || !/multimodal-ui\.js/.test(indexHtml)) throw new Error('Multimodal interface assets are missing.');
if (!/version:'3\.0\.0-beta\.22'/.test(serverSource)) throw new Error('Server runtime version must match beta.22.');
if (!/ULTRON_M3_LEAGUE_ARENA_ENABLED\s*\|\|\s*['"]0['"]/.test(serverSource)) throw new Error('Background Model Arena must be opt-in.');
for (const route of ['/api/files/upload','/api/files/read','/api/files/download','/api/media/generate','/api/voice/transcribe']) if (!serverSource.includes(route)) throw new Error(`Missing multimodal server route: ${route}`);

const config = require('../core/config');
const registry = require('../core/provider-registry');
const direct = require('../core/direct-provider-router');
const omniFallback = require('../core/omniroute-fallback');
const router = require('../core/model-router');
const conversation = require('../core/conversation');
const web = require('../core/web');
const codingBrain = require('../core/coding-brain');
const integrations = require('../core/integrations');
const founderBehavior = require('../core/founder-behavior');
const selfRepository = require('../core/self-repository');
const handoff = require('../core/assistant-handoff');
const multimodal = require('../core/multimodal');
const fileVault = require('../core/file-vault');
const nativeVoice = require('../core/native-voice-input');

if (process.env.ULTRON_MODEL_PROVIDER !== 'omniroute') throw new Error('Shared compatibility selector must remain omniroute.');
if (config.disableNvidiaInference !== false || !registry.PROVIDERS.nvidia) throw new Error('NVIDIA direct inference policy regressed.');
if (!direct.PROVIDERS.gemini.keys.includes('GEMINI_API_KEY2') || !direct.PROVIDERS.groq.keys.includes('GROQ_API_KEY2')) throw new Error('Direct multi-key pools regressed.');
if (direct.providerOrder('simple_qa')[0]!=='groq' || direct.providerOrder('research')[0]!=='gemini' || direct.providerOrder('coding')[0]!=='nvidia') throw new Error('Specialist provider routing regressed.');
if (typeof omniFallback.ensure!=='function' || omniFallback.status().mode!=='lazy-fallback') throw new Error('Lazy OmniRoute fallback API is incomplete.');
if (router.isBlockedModel('nvidia/openai/gpt-oss-120b')) throw new Error('NVIDIA model is incorrectly blocked.');
if (typeof codingBrain.run!=='function' || !codingBrain.shouldUse('Fix the wake-word bug in the interface','coding')) throw new Error('Coding Brain routing is incomplete.');
if (typeof integrations.githubSelfStatus!=='function' || typeof founderBehavior.apply!=='function') throw new Error('Core founder/self-status integration is incomplete.');
if (!selfRepository.isSelfRepositoryStatusIntent('Ultron check your own get hub for an update')) throw new Error('Self-GitHub voice intent regressed.');
if (!conversation.isContinuation('finish it now') || !conversation.isContinuation('just do it')) throw new Error('Continuation recovery regressed.');
if (handoff.responseDelivery('Anything else, Sir?').listenAfterResponseMs < 7000) throw new Error('Direct questions lost their no-wake reply window.');
if (web.status().primary !== 'tinyfish') throw new Error('TinyFish must remain primary public research.');
if (typeof multimodal.generate!=='function' || typeof multimodal.readFile!=='function' || multimodal.generationIntent('Ultron make a PDF report')?.kind!=='pdf') throw new Error('Multimodal core API is incomplete.');
if (!fileVault.status().maxFileBytes || typeof nativeVoice.transcribe!=='function') throw new Error('File vault/native voice APIs are incomplete.');

if (!web.status().configured) console.warn('[Mark 3] TinyFish warning: TINYFISH_API_KEY was not detected; live web search will be unavailable.');
else console.log('[Mark 3] TinyFish web layer configured: Fetch + Search enabled.');
console.log(`ULTRON Mark 3 beta.22 preflight passed: ${required.length} Mark 3 files, ${sharedTransport.length} shared transport files and ${js.length+sharedJs.length} JavaScript files validated.`);
