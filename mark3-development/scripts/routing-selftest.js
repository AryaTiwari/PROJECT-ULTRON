const fs = require('fs');
const path = require('path');
const direct = require('../core/direct-provider-router');
const arena = require('../core/model-arena');
const fallback = require('../core/omniroute-fallback');
const selfRepository = require('../core/self-repository');

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

// Self-repository routing must stay precise. Business/project prompts can naturally
// contain "Ultron", "lead source" and "changes" and must not be hijacked by GitHub status.
assert(selfRepository.isSelfRepositoryStatusIntent('Ultron, check your GitHub repository status and latest commit.'), 'Explicit self-repository status requests must still route deterministically.');
assert(selfRepository.isSelfRepositoryStatusIntent('Ultron, check your source code changes on the current branch.'), 'Explicit source-code repository checks must still route deterministically.');
assert(!selfRepository.isSelfRepositoryStatusIntent('Ultron, build me a Creator Lead Command Center with lead source filters and an activity history for meaningful changes.'), 'Elevate-style Forge build prompts must not be hijacked by self-repository status routing.');
assert(!selfRepository.isSelfRepositoryStatusIntent('Ultron, create a CRM with lead source, source attribution, and change history.'), 'Bare business uses of source/change must not count as repository status intent.');

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

console.log('ULTRON routing self-test passed: passive catalogs, quota-only key cooldowns, precise self-repository intent, passive Model League and retryable OmniRoute fallback validated.');
