const path = require('path');

function num(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(ROOT, '..');
const DATA = path.join(ROOT, 'data');

// Mark 3 owns its runtime. OmniRoute is only the inference transport.
process.env.ULTRON_MODEL_PROVIDER = 'omniroute';
process.env.ULTRON_M3_DISABLE_OPENCODE = '1';
process.env.ULTRON_DISABLE_OPENCODE = '1';
process.env.ULTRON_ENABLE_OPENCODE = '0';
delete process.env.ULTRON_DIRECT_DEFAULT_MODEL;
delete process.env.OPENCODE_API_KEY;
delete process.env.OPENCODE_GO_API_KEY;

function anchorProjectPathEnv(name, fallback) {
  const raw = String(process.env[name] || fallback).trim();
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
  process.env[name] = resolved;
  return resolved;
}

const voiceRoot = anchorProjectPathEnv('ULTRON_VOICE_ROOT', '.ultron/voice');
const voiceReferencePath = anchorProjectPathEnv('ULTRON_VOICE_REFERENCE_PATH', '.ultron/voice/ultron-reference.mp3');
const voiceCloneState = anchorProjectPathEnv('ULTRON_VOICE_CLONE_STATE', '.ultron/voice/voice-clone.json');
const voiceOutputDir = anchorProjectPathEnv('ULTRON_TTS_OUTPUT_DIR', '.ultron/audio');
const codingBrainWorkspace = anchorProjectPathEnv('ULTRON_M3_CODING_WORKSPACE', '.');
const omniRouteBase = String(process.env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:20128/v1').replace(/\/$/, '');

module.exports = {
  root: ROOT,
  projectRoot: PROJECT_ROOT,
  dataDir: DATA,
  workspaceDir: path.join(ROOT, 'workspace'),
  host: process.env.ULTRON_M3_HOST || '127.0.0.1',
  port: num('ULTRON_M3_PORT', 8790),
  omnirouteBase: omniRouteBase,
  omnirouteEndpointKey: String(process.env.OMNIROUTE_ENDPOINT_KEY || process.env.OMNIROUTE_API_KEY || process.env.ULTRON_OMNIROUTE_API_KEY || '').trim(),
  omniRouteStrict: false,
  disableBigPickle: true,
  disableOpenCode: true,
  disableNvidiaInference: true,
  agenticBridgeEnabled: /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_DEVIN_BRIDGE_ENABLED || '1')),
  agenticBridgeModel: process.env.ULTRON_M3_DEVIN_BRIDGE_MODEL || 'dva/swe-1-7-lightning',
  agenticBridgeTimeoutMs: num('ULTRON_M3_DEVIN_BRIDGE_TIMEOUT_MS', 180000),
  codingBrainEnabled: !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_CODING_BRAIN_ENABLED || '1')),
  codingBrainUrl: String(process.env.ULTRON_M3_CODING_BRAIN_URL || 'http://127.0.0.1:8791').replace(/\/$/, ''),
  codingBrainTimeoutMs: num('ULTRON_M3_CODING_BRAIN_TIMEOUT_MS', 600000),
  codingBrainStartupTimeoutMs: num('ULTRON_M3_CODING_BRAIN_STARTUP_TIMEOUT_MS', 15000),
  codingBrainAutoStart: !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_CODING_BRAIN_AUTOSTART || '1')),
  codingBrainAutoProvision: !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_CODING_BRAIN_AUTOPROVISION || '1')),
  codingBrainDir: String(process.env.ULTRON_M3_CODING_BRAIN_DIR || '').trim(),
  codingBrainRepo: String(process.env.ULTRON_M3_CODING_BRAIN_REPO || 'https://github.com/AryaTiwari/CODING-AGENT-BRAIN.git').trim(),
  codingBrainWorkspace,
  voiceRoot,
  voiceReferencePath,
  voiceCloneState,
  voiceOutputDir,
  voiceFallback: String(process.env.ULTRON_M3_VOICE_FALLBACK || 'windows-sapi').trim().toLowerCase(),
  githubToken: String(process.env.GITHUB_TOKEN || '').trim(),
  githubOwner: process.env.ULTRON_GITHUB_OWNER || 'AryaTiwari',
  githubRepo: process.env.ULTRON_GITHUB_REPO || 'PROJECT-ULTRON',
  githubBranch: process.env.ULTRON_GITHUB_BRANCH || 'mark3-development',
  memoryPath: path.join(DATA, 'memory.json'),
  commitmentsPath: path.join(DATA, 'commitments.json'),
  decisionsPath: path.join(DATA, 'decisions.json'),
  projectsPath: path.join(DATA, 'projects.json'),
  conversationPath: path.join(DATA, 'conversation.jsonl'),
  performancePath: path.join(DATA, 'model-performance.jsonl'),
  eventsPath: path.join(DATA, 'events.jsonl'),
  providerHealthPath: path.join(DATA, 'provider-health.json'),
  modelLeaguePath: path.join(DATA, 'model-league.json'),
  providerHealthTtlMs: num('ULTRON_M3_PROVIDER_HEALTH_TTL_MS', 30 * 60 * 1000),
  proactiveIntervalMs: num('ULTRON_M3_PROACTIVE_INTERVAL_MS', 120000),
  maxContextItems: num('ULTRON_M3_MAX_CONTEXT_ITEMS', 18),
  maxConversationItems: num('ULTRON_M3_MAX_CONVERSATION_ITEMS', 40),
};
