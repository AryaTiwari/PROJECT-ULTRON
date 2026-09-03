const fs = require('fs');
const path = require('path');
const direct = require('../core/direct-provider-router');
const arena = require('../core/model-arena');
const fallback = require('../core/omniroute-fallback');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const directSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'direct-provider-router.js'), 'utf8');
assert(/Discovery is deliberately passive/i.test(directSource), 'Model catalog discovery must remain passive and must not mutate inference cooldown state.');
assert(/if \(kind === 'RATE_LIMIT'\) return KEY_RATE_LIMIT_COOLDOWN_MS/.test(directSource), 'Verified rate limits must cool only the affected key.');
assert(/if \(kind === 'ACCESS'\) return KEY_ACCESS_COOLDOWN_MS/.test(directSource), 'Verified credential failures must isolate the affected key.');
assert(!/if \(kind === 'UPSTREAM'\) return KEY_/.test(directSource), 'Upstream/provider outages must never cool API keys.');
assert(/if \(kind === 'UPSTREAM' \|\| kind === 'UNKNOWN'\) break/.test(directSource), 'Provider outages must stop account rotation for that provider attempt.');
assert(direct.PROVIDERS.gemini.keys.includes('GEMINI_API_KEY2'), 'Gemini secondary account slot is missing.');
assert(direct.PROVIDERS.groq.keys.includes('GROQ_API_KEY2'), 'Groq secondary account slot is missing.');
assert(direct.providerOrder('research')[0] === 'gemini', 'Research must still prefer Gemini.');
assert(direct.providerOrder('simple_qa')[0] === 'groq', 'Fast simple Q&A must still prefer Groq.');

const arenaStatus = arena.status();
if (!process.env.ULTRON_M3_LEAGUE_ARENA_AUTORUN) {
  assert(arenaStatus.autoRun === false, 'Background Model Arena must be off by default to conserve free-tier quota.');
  assert(arenaStatus.learningMode === 'passive-operational-evidence', 'Model League must learn passively from real requests by default.');
}

const fallbackStatus = fallback.status();
assert(fallbackStatus.mode === 'lazy-fallback', 'OmniRoute must remain a lazy secondary transport.');
assert(fallbackStatus.timeoutMs >= 180000, 'Lazy OmniRoute needs enough time to boot on the target Windows laptop.');
assert(fallbackStatus.maxLaunchAttempts >= 2, 'Lazy OmniRoute must retry a failed launcher at least once.');
assert(/omniroute-lazy-launch\.log/i.test(fallbackStatus.launchLog || ''), 'Lazy OmniRoute startup must expose a diagnostic log path.');

console.log('ULTRON routing self-test passed: passive catalogs, quota-only key cooldowns, passive Model League and retryable OmniRoute fallback validated.');
