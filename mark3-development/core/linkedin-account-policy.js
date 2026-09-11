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

function settings() {
  return {
    localBudgetBypass: booleanSetting('ULTRON_M3_LINKEDIN_TEST_BYPASS_LOCAL_BUDGET', false),
    minGapMs: numberSetting('ULTRON_M3_LINKEDIN_MIN_GAP_MS', 9000, 5000, 60000),
    jitterMs: numberSetting('ULTRON_M3_LINKEDIN_JITTER_MS', 4000, 0, 15000),
    burstMax: numberSetting('ULTRON_M3_LINKEDIN_BURST_MAX', 10, 2, 12),
    burstWindowMs: numberSetting('ULTRON_M3_LINKEDIN_BURST_WINDOW_MS', 10 * 60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000),
    hourlyMax: numberSetting('ULTRON_M3_LINKEDIN_HOURLY_MAX', 24, 2, 30),
    dailyMax: numberSetting('ULTRON_M3_LINKEDIN_DAILY_MAX', 75, 5, 120),
    missionToolMax: numberSetting('ULTRON_M3_LINKEDIN_MISSION_TOOL_MAX', 12, 3, 20),
    rateLimitCooldownMs: numberSetting('ULTRON_M3_LINKEDIN_RATE_LIMIT_COOLDOWN_MS', 30 * 60 * 1000, 5 * 60 * 1000, 6 * 60 * 60 * 1000),
    errorBackoffCooldownMs: numberSetting('ULTRON_M3_LINKEDIN_ERROR_BACKOFF_MS', 10 * 60 * 1000, 5 * 60 * 1000, 60 * 60 * 1000),
    deepProfilesPerMission: numberSetting('ULTRON_M3_LINKEDIN_DEEP_PROFILE_MAX', 8, 1, 12),
    maxJobPages: numberSetting('ULTRON_M3_LINKEDIN_JOB_MAX_PAGES', 2, 1, 3),
    jobDetailMax: numberSetting('ULTRON_M3_LINKEDIN_JOB_DETAIL_MAX', 2, 0, 4),
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
  return state;
}

function classifyError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  if (/checkpoint|challenge|captcha|security verification|verify your identity|unusual activity|account restricted|temporarily restricted/.test(text)) {
    return { kind: 'manual-lock', reason: 'LinkedIn presented a security checkpoint/challenge. ULTRON stopped all account scraping until you re-authenticate manually.' };
  }
  if (/rate limit|too many requests|throttl|429|temporarily blocked|try again later/.test(text)) {
    return { kind: 'rate-limit', reason: 'LinkedIn rate limiting was detected.' };
  }
  if (/authentication|not logged in|login required|no valid linkedin session|session expired|source session/.test(text)) {
    return { kind: 'auth', reason: 'The LinkedIn browser session is missing or expired.' };
  }
  return { kind: 'other', reason: String(error?.message || error || 'LinkedIn tool error') };
}

function usage(state = loadState(), now = Date.now()) {
  prune(state, now);
  const limits = settings();
  const burst = now - limits.burstWindowMs;
  const hour = now - 60 * 60 * 1000;
  const day = now - 24 * 60 * 60 * 1000;
  const burstUsed = state.events.filter((event) => Number(event.at || 0) >= burst).length;
  const hourly = state.events.filter((event) => Number(event.at || 0) >= hour).length;
  const daily = state.events.filter((event) => Number(event.at || 0) >= day).length;
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
    if (counts.daily >= limits.dailyMax) {
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
  const now = Date.now();
  const last = Date.parse(check.state.lastCallAt || '');
  const elapsed = Number.isFinite(last) ? now - last : Infinity;
  const base = Math.max(0, check.limits.minGapMs - elapsed);
  const jitter = check.limits.jitterMs ? Math.floor(Math.random() * (check.limits.jitterMs + 1)) : 0;
  if (base + jitter > 0) await sleep(base + jitter);
  return preflight(tool);
}

function recordCall(tool, ok = true, metadata = {}) {
  const now = Date.now();
  const state = prune(loadState(), now);
  state.events.push({ at: now, tool, ok: Boolean(ok), ...metadata });
  state.lastCallAt = new Date(now).toISOString();
  saveState(state);
}

function recordError(tool, error) {
  const classification = classifyError(error);
  const state = prune(loadState());
  const now = Date.now();
  state.events.push({ at: now, tool, ok: false, errorKind: classification.kind });
  state.lastCallAt = new Date(now).toISOString();

  if (classification.kind === 'rate-limit') {
    state.cooldownUntil = new Date(now + adaptiveRateLimitCooldownMs(state, now)).toISOString();
  } else if (classification.kind === 'manual-lock') {
    state.manualLock = { at: new Date(now).toISOString(), reason: classification.reason };
  } else if (classification.kind === 'other') {
    const recentErrors = state.events.filter((event) => !event.ok && Number(event.at || 0) >= now - 30 * 60 * 1000);
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

function status() {
  const state = prune(loadState());
  saveState(state);
  const counts = usage(state);
  return {
    stateFile: STATE_FILE,
    ...settings(),
    burstUsed: counts.burst,
    hourlyUsed: counts.hourly,
    dailyUsed: counts.daily,
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
  loadState,
  saveState,
  classifyError,
  recentRateLimitStrikes,
  adaptiveRateLimitCooldownMs,
  usage,
  assertReadOnlyTool,
  preflight,
  waitTurn,
  recordCall,
  recordError,
  clearManualLock,
  status,
};
