const fs = require('fs');
const path = require('path');
const config = require('./config');

const ROOT = path.join(config.projectRoot, '.ultron', 'linkedin-account');
const STATE_FILE = path.join(ROOT, 'safety-state.json');

const READ_ONLY_TOOLS = new Set([
  'search_people',
  'search_companies',
  'get_person_profile',
  'get_company_profile',
  'get_company_posts',
  'get_company_employees',
  'search_jobs',
  'get_job_details',
  'search_posts',
]);

const WRITE_TOOLS = new Set([
  'send_message',
  'connect_with_person',
]);

function numberSetting(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : fallback));
}

function booleanSetting(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return Boolean(fallback);
  return /^(?:1|true|yes|on)$/i.test(String(raw).trim());
}

const TEMPORARY_DAILY_OVERRIDE_DATE = '2026-09-24';

function indiaDateKey(now = Date.now()) {
  return new Date(Number(now) + (5.5 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function temporaryDailyOverrideActive(now = Date.now(), configured = null) {
  const configuredDate = String(
    configured || process.env.ULTRON_M3_LINKEDIN_DAILY_OVERRIDE_DATE || TEMPORARY_DAILY_OVERRIDE_DATE
  ).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(configuredDate) && indiaDateKey(now) === configuredDate;
}

function indiaNextDateStart(dateKey) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));
  return `${next.toISOString().slice(0, 10)}T00:00:00+05:30`;
}

function runtimeAllowsTestBypass(scriptPath = process.argv?.[1], nodeEnv = process.env.NODE_ENV) {
  const script = String(scriptPath || '').toLowerCase();
  return /(?:selftest|live-test|diagnostic|doctor)\.(?:js|mjs|cjs)$/.test(script)
    || String(nodeEnv || '').toLowerCase() === 'test';
}

function settings(now = Date.now()) {
  const speedProfile = String(process.env.ULTRON_M3_LINKEDIN_SPEED_PROFILE || 'fast-safe').trim().toLowerCase();
  const migrateLegacy = speedProfile !== 'custom';
  const profiledNumber = (name, fallback, legacyDefaults, min, max) => {
    const raw = process.env[name];
    const parsed = Number(raw);
    const legacy = Array.isArray(legacyDefaults) ? legacyDefaults : [legacyDefaults];
    const shouldMigrate = migrateLegacy && Number.isFinite(parsed) && legacy.some((value) => Number(value) === parsed);
    const value = shouldMigrate ? fallback : (Number.isFinite(parsed) ? parsed : fallback);
    return Math.max(min, Math.min(max, value));
  };

  const dailyOverrideDate = String(
    process.env.ULTRON_M3_LINKEDIN_DAILY_OVERRIDE_DATE || TEMPORARY_DAILY_OVERRIDE_DATE
  ).trim();
  const dailyCapEnabled = !temporaryDailyOverrideActive(now, dailyOverrideDate);

  return {
    speedProfile,
    // Explicit operator override. This bypasses ULTRON's own burst/hour/day
    // counters only. Provider-side 429s, checkpoints, auth locks and cooldowns
    // remain authoritative and are never bypassed here.
    localBudgetBypass: booleanSetting('ULTRON_M3_LINKEDIN_LOCAL_BUDGET_BYPASS', false)
      || booleanSetting('ULTRON_M3_LINKEDIN_TEST_BYPASS_LOCAL_BUDGET', false),
    testMissionToolMax: numberSetting('ULTRON_M3_LINKEDIN_TEST_MISSION_TOOL_MAX', 120, 12, 120),
    testJobSearchMax: numberSetting('ULTRON_M3_LINKEDIN_TEST_JOB_SEARCH_MAX', 20, 4, 25),

    // Fast-safe defaults: higher throughput without disabling account safety.
    // Existing legacy/balanced-fast values automatically migrate unless the
    // operator explicitly chooses ULTRON_M3_LINKEDIN_SPEED_PROFILE=custom.
    minGapMs: profiledNumber('ULTRON_M3_LINKEDIN_MIN_GAP_MS', 3000, [9000, 6000, 5000], 2500, 60000),
    jitterMs: profiledNumber('ULTRON_M3_LINKEDIN_JITTER_MS', 250, [4000, 1200, 500], 0, 15000),
    burstMax: profiledNumber('ULTRON_M3_LINKEDIN_BURST_MAX', 12, [10, 12], 2, 12),
    burstWindowMs: profiledNumber('ULTRON_M3_LINKEDIN_BURST_WINDOW_MS', 5 * 60 * 1000, [10 * 60 * 1000, 8 * 60 * 1000], 5 * 60 * 1000, 30 * 60 * 1000),
    hourlyMax: profiledNumber('ULTRON_M3_LINKEDIN_HOURLY_MAX', 30, [24, 28], 2, 30),
    // One-day operator-authorized exception. It expires automatically at the
    // India date boundary; hourly/burst/provider/checkpoint safety stays active.
    dailyCapEnabled,
    dailyOverrideDate,
    dailyOverrideUntil: dailyCapEnabled ? null : indiaNextDateStart(dailyOverrideDate),
    dailyMax: profiledNumber('ULTRON_M3_LINKEDIN_DAILY_MAX', 120, [75, 90, 100], 5, 120),
    missionToolMax: profiledNumber('ULTRON_M3_LINKEDIN_MISSION_TOOL_MAX', 16, [12], 3, 20),
    rateLimitCooldownMs: profiledNumber('ULTRON_M3_LINKEDIN_RATE_LIMIT_COOLDOWN_MS', 10 * 60 * 1000, [30 * 60 * 1000], 5 * 60 * 1000, 6 * 60 * 60 * 1000),
    errorBackoffCooldownMs: profiledNumber('ULTRON_M3_LINKEDIN_ERROR_BACKOFF_MS', 5 * 60 * 1000, [10 * 60 * 1000], 5 * 60 * 1000, 60 * 60 * 1000),
    deepProfilesPerMission: profiledNumber('ULTRON_M3_LINKEDIN_DEEP_PROFILE_MAX', 10, [8], 1, 12),
    maxJobPages: numberSetting('ULTRON_M3_LINKEDIN_JOB_MAX_PAGES', 3, 1, 5),
    jobDetailMax: profiledNumber('ULTRON_M3_LINKEDIN_JOB_DETAIL_MAX', 4, [2], 0, 4),
  };
}

function recentRateLimitStrikes(state = loadState(), now = Date.now()) {
  const cutoff = now - 24 * 60 * 60 * 1000;
  return (state.events || []).filter((event) => event.errorKind === 'rate-limit' && Number(event.at || 0) >= cutoff).length;
}

function adaptiveRateLimitCooldownMs(state = loadState(), now = Date.now()) {
  const strikes = Math.max(1, recentRateLimitStrikes(state, now));
  const base = settings().rateLimitCooldownMs;
  return Math.min(6 * 60 * 60 * 1000, base * (2 ** Math.min(3, strikes - 1)));
}

function defaultState() {
  return {
    version: 1,
    events: [],
    cooldownUntil: null,
    manualLock: null,
    lastCallAt: null,
    updatedAt: new Date().toISOString(),
  };
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return defaultState();
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { ...defaultState(), ...parsed, events: Array.isArray(parsed.events) ? parsed.events : [] };
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  fs.mkdirSync(ROOT, { recursive: true });
  const next = { ...state, updatedAt: new Date().toISOString() };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(STATE_FILE, 0o600); } catch {}
  return next;
}

function prune(state, now = Date.now()) {
  const cutoff = now - 24 * 60 * 60 * 1000;
  state.events = (state.events || []).filter((event) => Number(event.at || 0) >= cutoff);
  if (state.cooldownUntil && Date.parse(state.cooldownUntil) <= now) state.cooldownUntil = null;

  // Older builds could create a local error-backoff cooldown from MCP startup
  // failures before those failures were separated from real LinkedIn account
  // safety signals. Preserve any explicit LinkedIn rate-limit cooldown and any
  // new-format counted "other" backoff, but clear legacy-only infrastructure
  // backoff so upgrading the runtime can actually recover.
  if (state.cooldownUntil && !state.manualLock) {
    const hasRateLimit = state.events.some((event) => String(event.errorKind || '').toLowerCase() === 'rate-limit');
    const hasNewCountedOther = state.events.some((event) =>
      event.countsTowardSafety === true && String(event.errorKind || '').toLowerCase() === 'other'
    );
    if (!hasRateLimit && !hasNewCountedOther) state.cooldownUntil = null;
  }
  return state;
}

function classifyError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  const code = String(error?.code || '').toLowerCase();
  if (/checkpoint|challenge|captcha|security verification|verify your identity|unusual activity|account restricted|temporarily restricted/.test(text)) {
    return { kind: 'manual-lock', reason: 'LinkedIn presented a security checkpoint/challenge. ULTRON stopped all account scraping until you re-authenticate manually.' };
  }
  if (/rate limit|too many requests|throttl|429|temporarily blocked|try again later/.test(text)) {
    return { kind: 'rate-limit', reason: 'LinkedIn rate limiting was detected.' };
  }
  if (/authentication|not logged in|login required|no valid linkedin session|session expired|source session/.test(text)) {
    return { kind: 'auth', reason: 'The LinkedIn browser session is missing or expired.' };
  }
  if (/linkedin_mcp_client_sdk_missing|linkedin_mcp_start_failed|linkedin_mcp_not_installed|linkedin_mcp_toolset_mismatch|enoent/.test(code)
      || /mcp client sdk is not installed|could not establish the stdio mcp connection|required tools are missing|could not start uvx/.test(text)) {
    return { kind: 'infrastructure', reason: 'The local LinkedIn MCP runtime failed before a LinkedIn account action could be confirmed. This is not an account-safety event.' };
  }
  if (/timeout|timed_out|request_timeout|connection_closed|etimedout|econnreset|epipe/.test(code)
      || /timed out|timeout|connection reset|connection closed|transport closed|socket hang up|broken pipe|temporary browser failure|another linkedin mcp client|browser.*(?:busy|using)|currently using the browser/.test(text)) {
    return { kind: 'transient', reason: 'The LinkedIn MCP/browser transport stalled temporarily. This is recoverable and is not treated as a LinkedIn account-safety event.' };
  }
  return { kind: 'other', reason: String(error?.message || error || 'LinkedIn tool error') };
}

function eventCountsTowardSafety(event = {}) {
  if (event.countsTowardSafety === true) return true;
  if (event.countsTowardSafety === false) return false;

  // Backward-compatible migration for safety-state files written before
  // countsTowardSafety existed. Confirmed successful calls and explicit
  // LinkedIn rate-limit/checkpoint events remain counted. Ambiguous legacy
  // failures (especially old MCP startup/transport errors classified as
  // "other") no longer burn account-call quota after an upgrade.
  if (event.ok === true) return true;
  const kind = String(event.errorKind || '').toLowerCase();
  if (kind === 'rate-limit' || kind === 'manual-lock') return true;
  return false;
}

function usage(state = loadState(), now = Date.now()) {
  prune(state, now);
  const limits = settings();
  const burst = now - limits.burstWindowMs;
  const hour = now - 60 * 60 * 1000;
  const day = now - 24 * 60 * 60 * 1000;
  const safetyEvents = state.events.filter(eventCountsTowardSafety);
  const burstUsed = safetyEvents.filter((event) => Number(event.at || 0) >= burst).length;
  const hourly = safetyEvents.filter((event) => Number(event.at || 0) >= hour).length;
  const daily = safetyEvents.filter((event) => Number(event.at || 0) >= day).length;
  return { burst: burstUsed, hourly, daily };
}

function assertReadOnlyTool(tool) {
  if (WRITE_TOOLS.has(tool)) {
    const error = new Error(`LinkedIn write action "${tool}" is disabled in Lead Research mode.`);
    error.code = 'LINKEDIN_WRITE_ACTION_DISABLED';
    throw error;
  }
  if (!READ_ONLY_TOOLS.has(tool)) {
    const error = new Error(`LinkedIn tool "${tool}" is not on ULTRON's read-only allowlist.`);
    error.code = 'LINKEDIN_TOOL_NOT_ALLOWED';
    throw error;
  }
}

function preflight(tool) {
  assertReadOnlyTool(tool);
  const now = Date.now();
  const state = prune(loadState(), now);
  if (state.manualLock) {
    const error = new Error(state.manualLock.reason || 'LinkedIn account scraping is locked pending manual re-authentication.');
    error.code = 'LINKEDIN_MANUAL_LOCK';
    error.manualLock = state.manualLock;
    throw error;
  }
  if (state.cooldownUntil && Date.parse(state.cooldownUntil) > now) {
    const remainingMs = Date.parse(state.cooldownUntil) - now;
    const error = new Error(`LinkedIn safety cooldown is active for about ${Math.ceil(remainingMs / 60000)} more minute(s).`);
    error.code = 'LINKEDIN_COOLDOWN_ACTIVE';
    error.cooldownUntil = state.cooldownUntil;
    throw error;
  }
  const limits = settings();
  const counts = usage(state, now);
  if (!limits.localBudgetBypass) {
    if (counts.burst >= limits.burstMax) {
      const error = new Error(`LinkedIn short-window safety cap reached (${counts.burst}/${limits.burstMax}). Pause before continuing this mission.`);
      error.code = 'LINKEDIN_BURST_CAP';
      throw error;
    }
    if (counts.hourly >= limits.hourlyMax) {
      const error = new Error(`LinkedIn hourly safety cap reached (${counts.hourly}/${limits.hourlyMax}). Wait before another account scrape.`);
      error.code = 'LINKEDIN_HOURLY_CAP';
      throw error;
    }
    if (limits.dailyCapEnabled && counts.daily >= limits.dailyMax) {
      const error = new Error(`LinkedIn daily safety cap reached (${counts.daily}/${limits.dailyMax}). Resume tomorrow rather than pushing the account harder.`);
      error.code = 'LINKEDIN_DAILY_CAP';
      throw error;
    }
  }
  return { state, limits, counts };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitTurn(tool) {
  const check = preflight(tool);
  // Emergency/local-budget bypass means exactly that: no ULTRON-side spacing,
  // burst, hourly, or daily throttle. Real provider cooldown/manual-lock checks
  // still happen in preflight() before this point.
  if (check.limits.localBudgetBypass) return check;
  const now = Date.now();
  const last = Date.parse(check.state.lastSafetyCallAt || check.state.lastCallAt || '');
  const elapsed = Number.isFinite(last) ? now - last : Infinity;
  const base = Math.max(0, check.limits.minGapMs - elapsed);
  const jitter = check.limits.jitterMs ? Math.floor(Math.random() * (check.limits.jitterMs + 1)) : 0;
  if (base + jitter > 0) await sleep(base + jitter);
  return preflight(tool);
}

function recordCall(tool, ok = true, metadata = {}) {
  const now = Date.now();
  const state = prune(loadState(), now);
  state.events.push({
    at: now,
    tool,
    ok: Boolean(ok),
    countsTowardSafety: true,
    runtimeTestBypass: Boolean(settings().localBudgetBypass),
    sourceScript: path.basename(String(process.argv?.[1] || '')),
    ...metadata,
  });
  state.lastCallAt = new Date(now).toISOString();
  state.lastSafetyCallAt = state.lastCallAt;
  saveState(state);
}

function recordError(tool, error) {
  const classification = classifyError(error);
  const state = prune(loadState());
  const now = Date.now();
  const countsTowardSafety = !['transient', 'infrastructure', 'auth'].includes(classification.kind);
  state.events.push({ at: now, tool, ok: false, errorKind: classification.kind, countsTowardSafety });
  state.lastErrorAt = new Date(now).toISOString();
  if (countsTowardSafety) {
    state.lastCallAt = state.lastErrorAt;
    state.lastSafetyCallAt = state.lastErrorAt;
  }

  if (classification.kind === 'rate-limit') {
    state.cooldownUntil = new Date(now + adaptiveRateLimitCooldownMs(state, now)).toISOString();
  } else if (classification.kind === 'manual-lock') {
    state.manualLock = { at: new Date(now).toISOString(), reason: classification.reason };
  } else if (classification.kind === 'other') {
    const recentErrors = state.events.filter((event) => !event.ok
      && event.errorKind === 'other'
      && Number(event.at || 0) >= now - 30 * 60 * 1000);
    if (recentErrors.length >= 3) {
      state.cooldownUntil = new Date(now + settings().errorBackoffCooldownMs).toISOString();
    }
  }
  saveState(state);
  return classification;
}

function clearManualLock(reason = 'manual re-authentication confirmed') {
  const state = prune(loadState());
  state.manualLock = null;
  // Re-authentication may clear a checkpoint lock, but it must never erase a
  // rate-limit cooldown. Cooldowns expire only by time.
  state.unlockedAt = new Date().toISOString();
  state.unlockReason = reason;
  saveState(state);
  return status();
}

function nextEligibleAt(state = loadState(), now = Date.now()) {
  const current = prune({ ...state, events: Array.isArray(state.events) ? [...state.events] : [] }, now);
  if (current.manualLock) return null;
  if (current.cooldownUntil && Date.parse(current.cooldownUntil) > now) {
    return current.cooldownUntil;
  }

  const limits = settings(now);
  if (limits.localBudgetBypass) return new Date(now).toISOString();
  const events = (current.events || []).filter(eventCountsTowardSafety).map((event) => Number(event.at || 0)).filter(Number.isFinite).sort((a, b) => a - b);
  const candidates = [now];

  const last = Date.parse(current.lastSafetyCallAt || current.lastCallAt || '');
  if (Number.isFinite(last)) candidates.push(last + limits.minGapMs);

  const thresholdExpiry = (windowEvents, limit, windowMs) => {
    if (windowEvents.length < limit) return null;
    // preflight blocks while usage >= limit. If usage is already above the
    // limit (possible after a previous test-bypass build), wait until enough
    // oldest events expire to leave limit-1 active events. Waking after only
    // the first expiry would cause repeated waiting_safety loops.
    const expiryIndex = Math.max(0, windowEvents.length - limit);
    return Number(windowEvents[expiryIndex]) + windowMs + 1000;
  };

  const burstEvents = events.filter((at) => at >= now - limits.burstWindowMs);
  const burstReady = thresholdExpiry(burstEvents, limits.burstMax, limits.burstWindowMs);
  if (burstReady) candidates.push(burstReady);

  const hourEvents = events.filter((at) => at >= now - 60 * 60 * 1000);
  const hourReady = thresholdExpiry(hourEvents, limits.hourlyMax, 60 * 60 * 1000);
  if (hourReady) candidates.push(hourReady);

  if (limits.dailyCapEnabled) {
    const dayEvents = events.filter((at) => at >= now - 24 * 60 * 60 * 1000);
    const dayReady = thresholdExpiry(dayEvents, limits.dailyMax, 24 * 60 * 60 * 1000);
    if (dayReady) candidates.push(dayReady);
  }

  return new Date(Math.max(...candidates)).toISOString();
}

function status() {
  const state = prune(loadState());
  saveState(state);
  const counts = usage(state);
  const eventBreakdown = {};
  for (const event of state.events || []) {
    const kind = String(event.errorKind || (event.ok ? 'success' : 'failed-unspecified'));
    const key = eventCountsTowardSafety(event) ? `counted:${kind}` : `ignored:${kind}`;
    eventBreakdown[key] = Number(eventBreakdown[key] || 0) + 1;
  }
  return {
    stateFile: STATE_FILE,
    ...settings(),
    burstUsed: counts.burst,
    hourlyUsed: counts.hourly,
    dailyUsed: counts.daily,
    dailyCapEnabled: Boolean(settings().dailyCapEnabled),
    dailyOverrideDate: settings().dailyOverrideDate,
    dailyOverrideUntil: settings().dailyOverrideUntil,
    eventBreakdown,
    nextEligibleAt: nextEligibleAt(state),
    overCapBy: {
      burst: Math.max(0, Number(counts.burst || 0) - Number(settings().burstMax || 0) + 1),
      hourly: Math.max(0, Number(counts.hourly || 0) - Number(settings().hourlyMax || 0) + 1),
      daily: settings().dailyCapEnabled
        ? Math.max(0, Number(counts.daily || 0) - Number(settings().dailyMax || 0) + 1)
        : 0,
    },
    rateLimitStrikes24h: recentRateLimitStrikes(state),
    localBudgetBypass: Boolean(settings().localBudgetBypass),
    cooldownUntil: state.cooldownUntil,
    manualLock: state.manualLock,
    readOnlyTools: [...READ_ONLY_TOOLS],
    writeActionsDisabled: [...WRITE_TOOLS],
  };
}

module.exports = {
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  settings,
  booleanSetting,
  runtimeAllowsTestBypass,
  indiaDateKey,
  temporaryDailyOverrideActive,
  indiaNextDateStart,
  loadState,
  saveState,
  classifyError,
  recentRateLimitStrikes,
  adaptiveRateLimitCooldownMs,
  usage,
  eventCountsTowardSafety,
  assertReadOnlyTool,
  preflight,
  waitTurn,
  recordCall,
  recordError,
  clearManualLock,
  nextEligibleAt,
  status,
};
