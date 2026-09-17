// Balanced Apollo contact-quality policy for the first-class 3-POC domain.
//
// Discovery remains on the 0-credit People API Search path. This module only
// deepens EMAIL enrichment after ULTRON has already verified a final POC via
// Apollo identity + employer evidence. It never waterfalls the candidate pool,
// never enables personal-email reveal, and never enables phone waterfall.
//
// The module wraps only the two exact-person helpers used by anchored 3-POC
// POC-2/POC-3 verification/selection. Generic lead enrichment remains on the
// original credit-saver policy.

const apollo = require('./apollo-enrichment');

const APOLLO_MATCH = 'https://api.apollo.io/api/v1/people/match';
const APOLLO_WEBHOOK_RESULT = 'https://api.apollo.io/api/v1/webhook_result';
const INSTALL_FLAG = Symbol.for('ultron.mark3.apolloThreePocQuality.installed');

let runState = freshRunState();

function freshRunState() {
  return {
    startedAt: new Date().toISOString(),
    waterfallStarted: 0,
    waterfallCacheHits: 0,
    waterfallSucceeded: 0,
    waterfallPending: 0,
    waterfallNotFound: 0,
    waterfallBudgetSkips: 0,
    waterfallCooldownSkips: 0,
    waterfallErrors: 0,
  };
}

function numberSetting(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = Number(apollo.setting(name, String(fallback)));
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

function maxWaterfalls() {
  // Balanced default. Discovery is still free and unlimited by this budget;
  // this cap applies only to final, verified POCs whose email is still missing.
  return Math.floor(numberSetting('ULTRON_M3_THREE_POC_EMAIL_WATERFALL_MAX', 30, 0, 150));
}

function cooldownDays() {
  return numberSetting('ULTRON_M3_THREE_POC_EMAIL_WATERFALL_COOLDOWN_DAYS', 14, 1, 90);
}

function maxPolls() {
  return Math.floor(numberSetting('ULTRON_M3_THREE_POC_EMAIL_WATERFALL_POLLS', 2, 0, 8));
}

function maxPollWaitMs() {
  return Math.floor(numberSetting('ULTRON_M3_THREE_POC_EMAIL_WATERFALL_MAX_WAIT_MS', 2500, 250, 10000));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestIdFromRaw(raw, parsed = {}) {
  // Apollo request_id is signed int64 and can exceed JS safe integer range.
  // Preserve the exact text from the response instead of trusting JSON.parse.
  const match = String(raw || '').match(/"request_id"\s*:\s*"?(-?\d+)"?/i);
  if (match?.[1]) return match[1];
  if (parsed?.request_id != null) return String(parsed.request_id);
  return '';
}

function validBusinessEmail(value) {
  return apollo.validEmail(value);
}

function emailFromEntry(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return validBusinessEmail(entry);
  if (typeof entry !== 'object') return null;
  const type = String(entry.type || entry.email_type || entry.category || '').toLowerCase();
  // Balanced quality mode is for business outreach. Never upgrade quality by
  // silently switching to a personal/private mailbox.
  if (/personal|private|home/.test(type)) return null;
  return validBusinessEmail(entry.email || entry.address || entry.value || '');
}

function emailFromPayload(payload) {
  const roots = [];
  if (payload?.person) roots.push(payload.person);
  if (payload?.contact) roots.push(payload.contact);
  if (Array.isArray(payload?.people)) roots.push(...payload.people);
  if (Array.isArray(payload?.matches)) roots.push(...payload.matches);

  for (const person of roots) {
    const direct = validBusinessEmail(person?.email || '');
    if (direct) return direct;
    for (const entry of Array.isArray(person?.emails) ? person.emails : []) {
      const email = emailFromEntry(entry);
      if (email) return email;
    }
    const waterfall = person?.waterfall;
    if (waterfall) {
      const directWaterfall = validBusinessEmail(waterfall?.email || '');
      if (directWaterfall) return directWaterfall;
      for (const entry of Array.isArray(waterfall?.emails) ? waterfall.emails : []) {
        const email = emailFromEntry(entry);
        if (email) return email;
      }
    }
  }
  return null;
}

function cacheEntryFor(result) {
  const linkedIn = apollo.normalizeLinkedIn(result?.linkedinUrl || result?.returnedLinkedIn || '');
  const id = String(result?.apolloPersonId || result?.id || '').trim();
  const cache = apollo.readCache();
  if (linkedIn && cache.people?.[linkedIn]) return { cache, linkedIn, record: cache.people[linkedIn] };
  if (id) {
    for (const [url, record] of Object.entries(cache.people || {})) {
      if (String(record?.apolloPersonId || '') === id) return { cache, linkedIn: url, record };
    }
  }
  return { cache, linkedIn: linkedIn || null, record: null };
}

function saveWaterfallState(result, patch) {
  const found = cacheEntryFor(result);
  if (!found.linkedIn) return;
  const record = { ...(found.record || {}), ...patch };
  record.checkedAt = new Date().toISOString();
  found.cache.people[found.linkedIn] = record;
  apollo.saveCache(found.cache);
}

function recentAttempt(record) {
  const at = Date.parse(record?.threePocEmailWaterfallAttemptedAt || '');
  if (!Number.isFinite(at)) return false;
  return Date.now() - at < cooldownDays() * 86400000;
}

async function pollRequest(requestId) {
  const apiKey = apollo.setting('APOLLO_API_KEY');
  if (!apiKey || !requestId) return { state: 'error', email: null, payload: null };

  const polls = maxPolls();
  for (let attempt = 0; attempt <= polls; attempt++) {
    const response = await fetch(`${APOLLO_WEBHOOK_RESULT}/${encodeURIComponent(String(requestId))}`, {
      headers: { 'x-api-key': apiKey, Accept: 'application/json', 'Cache-Control': 'no-cache' },
    });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch {}

    if (response.ok) {
      const email = emailFromPayload(data);
      return { state: email ? 'found' : 'not_found', email, payload: data };
    }

    const code = String(data?.error_code || data?.code || '').toLowerCase();
    if (response.status === 404 && code === 'result_pending') {
      if (attempt >= polls) return { state: 'pending', email: null, payload: data };
      const seconds = Number(data?.retry_after_seconds || 1);
      const wait = Math.min(maxPollWaitMs(), Math.max(250, (Number.isFinite(seconds) ? seconds : 1) * 1000));
      await sleep(wait);
      continue;
    }

    if (
      (response.status === 404 && code === 'request_id_unknown')
      || (response.status === 410 && code === 'request_id_expired')
      || (response.status === 400 && code === 'invalid_request_id')
    ) return { state: 'terminal', email: null, payload: data };

    return { state: 'error', email: null, payload: data };
  }
  return { state: 'pending', email: null, payload: null };
}

async function startWaterfall(result) {
  const apiKey = apollo.setting('APOLLO_API_KEY');
  const id = String(result?.apolloPersonId || result?.id || '').trim();
  const linkedin = apollo.normalizeLinkedIn(result?.linkedinUrl || result?.returnedLinkedIn || '');
  if (!apiKey || (!id && !linkedin)) return { state: 'error', email: null, requestId: '' };

  const url = new URL(APOLLO_MATCH);
  if (id) url.searchParams.set('id', id);
  else url.searchParams.set('linkedin_url', linkedin);
  url.searchParams.set('run_waterfall_email', 'true');
  url.searchParams.set('run_waterfall_phone', 'false');
  url.searchParams.set('reveal_personal_emails', 'false');
  url.searchParams.set('reveal_phone_number', 'false');
  url.searchParams.set('poll_only', 'true');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    },
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) return { state: 'error', email: null, requestId: '', payload: data };

  const immediate = emailFromPayload(data);
  const requestId = requestIdFromRaw(raw, data);
  if (immediate) return { state: 'found', email: immediate, requestId, payload: data };
  if (!requestId) return { state: 'not_found', email: null, requestId: '', payload: data };
  const polled = await pollRequest(requestId);
  return { ...polled, requestId, payload: polled.payload || data };
}

async function improveVerifiedEmail(result) {
  if (!result || result.noMatch || result.ambiguous || result.identityVerified === false) return result;
  if (validBusinessEmail(result.email)) return result;

  const found = cacheEntryFor(result);
  const record = found.record || {};
  const existing = validBusinessEmail(record.email);
  if (existing) {
    runState.waterfallCacheHits++;
    return { ...result, email: existing, emailKnown: true, emailWaterfallStatus: 'cached' };
  }

  // Reuse/poll an already-paid request before spending another credit.
  const pendingId = String(record.threePocEmailWaterfallRequestId || '').trim();
  if (pendingId && record.threePocEmailWaterfallStatus === 'pending') {
    const polled = await pollRequest(pendingId);
    if (polled.state === 'found' && polled.email) {
      runState.waterfallSucceeded++;
      saveWaterfallState(result, {
        email: polled.email,
        emailKnown: true,
        threePocEmailWaterfallStatus: 'found',
        threePocEmailWaterfallResolvedAt: new Date().toISOString(),
      });
      return { ...result, email: polled.email, emailKnown: true, emailWaterfallStatus: 'found' };
    }
    if (polled.state === 'pending') {
      runState.waterfallPending++;
      return { ...result, emailWaterfallPending: true, emailWaterfallStatus: 'pending' };
    }
    saveWaterfallState(result, {
      threePocEmailWaterfallStatus: polled.state === 'not_found' ? 'not_found' : 'terminal',
      threePocEmailWaterfallResolvedAt: new Date().toISOString(),
    });
  }

  if (recentAttempt(record)) {
    runState.waterfallCooldownSkips++;
    return { ...result, emailWaterfallStatus: record.threePocEmailWaterfallStatus || 'cooldown' };
  }

  if (runState.waterfallStarted >= maxWaterfalls()) {
    runState.waterfallBudgetSkips++;
    return { ...result, emailWaterfallStatus: 'budget_cap' };
  }

  runState.waterfallStarted++;
  const attemptedAt = new Date().toISOString();
  saveWaterfallState(result, {
    threePocEmailWaterfallAttemptedAt: attemptedAt,
    threePocEmailWaterfallStatus: 'starting',
  });

  try {
    const waterfall = await startWaterfall(result);
    if (waterfall.state === 'found' && waterfall.email) {
      runState.waterfallSucceeded++;
      saveWaterfallState(result, {
        email: waterfall.email,
        emailKnown: true,
        threePocEmailWaterfallRequestId: waterfall.requestId || null,
        threePocEmailWaterfallStatus: 'found',
        threePocEmailWaterfallResolvedAt: new Date().toISOString(),
      });
      return { ...result, email: waterfall.email, emailKnown: true, emailWaterfallStatus: 'found' };
    }

    if (waterfall.state === 'pending') {
      runState.waterfallPending++;
      saveWaterfallState(result, {
        threePocEmailWaterfallRequestId: waterfall.requestId,
        threePocEmailWaterfallStatus: 'pending',
      });
      return { ...result, emailWaterfallPending: true, emailWaterfallStatus: 'pending' };
    }

    if (waterfall.state === 'not_found' || waterfall.state === 'terminal') {
      runState.waterfallNotFound++;
      saveWaterfallState(result, {
        threePocEmailWaterfallRequestId: waterfall.requestId || null,
        threePocEmailWaterfallStatus: 'not_found',
        threePocEmailWaterfallResolvedAt: new Date().toISOString(),
      });
      return { ...result, emailWaterfallStatus: 'not_found' };
    }

    runState.waterfallErrors++;
    saveWaterfallState(result, {
      threePocEmailWaterfallRequestId: waterfall.requestId || null,
      threePocEmailWaterfallStatus: 'error',
    });
    return { ...result, emailWaterfallStatus: 'error' };
  } catch {
    runState.waterfallErrors++;
    saveWaterfallState(result, { threePocEmailWaterfallStatus: 'error' });
    return { ...result, emailWaterfallStatus: 'error' };
  }
}

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];

  const originalResolveDecisionMaker = apollo.resolveDecisionMaker.bind(apollo);
  const originalResolvePersonByNameCompany = apollo.resolvePersonByNameCompany.bind(apollo);

  apollo.resolveDecisionMaker = async function balancedResolveDecisionMaker(candidate, company, domain, options = {}) {
    const result = await originalResolveDecisionMaker(candidate, company, domain, options);
    if (options.needEmail === false) return result;
    return improveVerifiedEmail(result);
  };

  apollo.resolvePersonByNameCompany = async function balancedResolvePersonByNameCompany(name, company, domain, options = {}) {
    const result = await originalResolvePersonByNameCompany(name, company, domain, options);
    if (options.needEmail === false) return result;
    return improveVerifiedEmail(result);
  };

  const api = Object.freeze({
    startRun,
    stats,
    improveVerifiedEmail,
    maxWaterfalls,
  });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

function startRun() {
  runState = freshRunState();
  return stats();
}

function stats() {
  return {
    ...runState,
    maxWaterfalls: maxWaterfalls(),
    cooldownDays: cooldownDays(),
    maxPolls: maxPolls(),
    personalEmailReveal: false,
    phoneWaterfall: false,
    scope: 'final-verified-pocs-only',
  };
}

module.exports = {
  install,
  startRun,
  stats,
  improveVerifiedEmail,
  emailFromPayload,
  requestIdFromRaw,
};
