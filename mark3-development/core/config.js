const path = require('path');

function num(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const omniRouteBase = String(process.env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:20128/v1').replace(/\/$/, '');

// Mark 3 is intentionally running with OpenCode disabled for the current
// routing investigation. This stays Mark-3-local and does not alter Mark 2.
process.env.ULTRON_M3_DISABLE_OPENCODE = '1';
// Prefer NVIDIA NIM directly when its credential is available. GLM-5.2's free
// endpoint was retired on 2026-08-21, so use the current free Nemotron 3.5
// Lightning endpoint instead and bypass stale OmniRoute provider catalogs.
if (!process.env.ULTRON_DIRECT_DEFAULT_MODEL) process.env.ULTRON_DIRECT_DEFAULT_MODEL = 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b';

module.exports = {
  root: ROOT,
  dataDir: DATA,
  workspaceDir: path.join(ROOT, 'workspace'),
  host: process.env.ULTRON_M3_HOST || '127.0.0.1',
  port: num('ULTRON_M3_PORT', 8790),
  omnirouteBase: omniRouteBase,
  omnirouteEndpointKey: String(process.env.OMNIROUTE_ENDPOINT_KEY || process.env.OMNIROUTE_API_KEY || process.env.ULTRON_OMNIROUTE_API_KEY || '').trim(),
  omniRouteStrict: !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_OMNIROUTE_STRICT || '1')),
  disableBigPickle: !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_DISABLE_BIG_PICKLE || '1')),
  disableOpenCode: true,
  agenticBridgeEnabled: /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_DEVIN_BRIDGE_ENABLED || '1')),
  agenticBridgeModel: process.env.ULTRON_M3_DEVIN_BRIDGE_MODEL || 'dva/swe-1-7-lightning',
  agenticBridgeTimeoutMs: num('ULTRON_M3_DEVIN_BRIDGE_TIMEOUT_MS', 180000),
  parentCore: String(process.env.ULTRON_PARENT_CORE_URL || 'http://127.0.0.1:8787').replace(/\/$/, ''),
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
  providerHealthTtlMs: num('ULTRON_M3_PROVIDER_HEALTH_TTL_MS', 30 * 60 * 1000),
  proactiveIntervalMs: num('ULTRON_M3_PROACTIVE_INTERVAL_MS', 120000),
  maxContextItems: num('ULTRON_M3_MAX_CONTEXT_ITEMS', 18),
  maxConversationItems: num('ULTRON_M3_MAX_CONVERSATION_ITEMS', 40),
};
