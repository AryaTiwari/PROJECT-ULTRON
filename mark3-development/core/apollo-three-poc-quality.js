// Balanced Apollo contact-quality policy for the first-class 3-POC domain.
//
// Discovery remains on the 0-credit People API Search path. This module deepens
// contact enrichment only AFTER ULTRON has verified a final POC via exact identity
// + employer evidence. Email waterfall and phone waterfall are therefore applied
// only to final verified people, never to candidate pools. Personal-email reveal
// remains disabled.

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
    phoneWaterfallStarted: 0,
    phoneWaterfallCacheHits: 0,
    phoneWaterfallSucceeded: 0,
    phoneWaterfallPending: 0,
    phoneWaterfallNotFound: 0,
    phoneWaterfallBudgetSkips: 0,
    phoneWaterfallCooldownSkips: 0,
    phoneWaterfallErrors: 0,
    phoneWaterfallUnavailable: 0,
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

function phoneWaterfallEnabled() {
  // Native Apollo reveal + webhook settlement is the production default.
  // The custom poll-only phone waterfall is an opt-in experimental fallback.
  return /^(1|true|yes|on)$/i.test(String(apollo.setting('ULTRON_M3_THREE_POC_PHONE_WATERFALL', '0')).trim());
}

function maxPhoneWaterfalls() {
  return Math.floor(numberSetting('ULTRON_M3_THREE_POC_PHONE_WATERFALL_MAX', 20, 0, 100));
}

function phoneCooldownDays() {
  return numberSetting('ULTRON_M3_THREE_POC_PHONE_WATERFALL_COOLDOWN_DAYS', 7, 1, 90);
}

function phonePolls() {
  return Math.floor(numberSetting('ULTRON_M3_THREE_POC_PHONE_WATERFALL_POLLS', 3, 0, 8));
}

function phonePollWaitMs() {
  return Math.floor(numberSetting('ULTRON_M3_THREE_POC_PHONE_WATERFALL_MAX_WAIT_MS', 1800, 250, 10000));
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

function phoneFromEntry(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return apollo.validPhone(entry);
  if (typeof entry !== 'object') return null;

  const direct = apollo.validPhone(
    entry.sanitized_number
    || entry.raw_number
    || entry.phone_number
    || entry.phone
    || entry.number
    || entry.value
    || ''
  );
  if (direct) return direct;

  for (const number of Array.isArray(entry.phone_numbers) ? entry.phone_numbers : []) {
    const phone = phoneFromEntry(number);
    if (phone) return phone;
  }
  for (const vendor of Array.isArray(entry.vendors) ? entry.vendors : []) {
    for (const number of Array.isArray(vendor?.phone_numbers) ? vendor.phone_numbers : []) {
      const phone = phoneFromEntry(number);
      if (phone) return phone;
    }
  }
  return null;
}

function phoneFromPayload(payload) {
  const roots = [];
  if (payload?.person) roots.push(payload.person);
  if (payload?.contact) roots.push(payload.contact);
  if (Array.isArray(payload?.people)) roots.push(...payload.people);
  if (Array.isArray(payload?.matches)) roots.push(...payload.matches);

  for (const person of roots) {
    const direct = phoneFromEntry(person);
    if (direct) return direct;

    for (const entry of Array.isArray(person?.phone_numbers) ? person.phone_numbers : []) {
      const phone = phoneFromEntry(entry);
      if (phone) return phone;
    }

    const waterfall = person?.waterfall;
    for (const entry of Array.isArray(waterfall?.phone_numbers) ? waterfall.phone_numbers : []) {
      const phone = phoneFromEntry(entry);
      if (phone) return phone;
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

function recentPhoneAttempt(record) {
  const at = Date.parse(record?.threePocPhoneWaterfallAttemptedAt || '');
  if (!Number.isFinite(at)) return false;
  return Date.now() - at < phoneCooldownDays() * 86400000;
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


async function pollPhoneRequest(requestId, options = {}) {
  const apiKey = apollo.setting('APOLLO_API_KEY');
  if (!apiKey || !requestId) return { state: 'error', phone: null, payload: null };

  const requestedPolls = Number(options.polls);
  const polls = Number.isFinite(requestedPolls)
    ? Math.max(0, Math.min(8, Math.floor(requestedPolls)))
    : phonePolls();
  for (let attempt = 0; attempt <= polls; attempt++) {
    const response = await fetch(`${APOLLO_WEBHOOK_RESULT}/${encodeURIComponent(String(requestId))}`, {
      headers: { 'x-api-key': apiKey, Accept: 'application/json', 'Cache-Control': 'no-cache' },
    });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch {}

    if (response.ok) {
      const phone = phoneFromPayload(data);
      return { state: phone ? 'found' : 'not_found', phone, payload: data };
    }

    const code = String(data?.error_code || data?.code || '').toLowerCase();
    if (response.status === 404 && code === 'result_pending') {
      if (attempt >= polls) return { state: 'pending', phone: null, payload: data };
      const seconds = Number(data?.retry_after_seconds || 1);
      const wait = Math.min(phonePollWaitMs(), Math.max(250, (Number.isFinite(seconds) ? seconds : 1) * 1000));
      await sleep(wait);
      continue;
    }

    if (
      (response.status === 404 && code === 'request_id_unknown')
      || (response.status === 410 && code === 'request_id_expired')
      || (response.status === 400 && code === 'invalid_request_id')
    ) return { state: 'terminal', phone: null, payload: data };

    return { state: 'error', phone: null, payload: data };
  }
  return { state: 'pending', phone: null, payload: null };
}

async function startPhoneWaterfall(result) {
  const apiKey = apollo.setting('APOLLO_API_KEY');
  const id = String(result?.apolloPersonId || result?.id || '').trim();
  const linkedin = apollo.normalizeLinkedIn(result?.linkedinUrl || result?.returnedLinkedIn || '');
  const email = validBusinessEmail(result?.email || '');
  if (!apiKey || (!id && !linkedin && !email)) return { state: 'error', phone: null, requestId: '' };

  const url = new URL(APOLLO_MATCH);
  if (id) url.searchParams.set('id', id);
  else if (linkedin) url.searchParams.set('linkedin_url', linkedin);
  else url.searchParams.set('email', email);

  url.searchParams.set('run_waterfall_email', 'false');
  url.searchParams.set('run_waterfall_phone', 'true');
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
  if (!response.ok) return { state: 'error', phone: null, requestId: '', payload: data };

  const immediate = phoneFromPayload(data);
  const requestId = requestIdFromRaw(raw, data);
  const waterfallStatus = String(data?.waterfall?.status || '').toLowerCase();
  if (immediate) return { state: 'found', phone: immediate, requestId, payload: data };
  if (waterfallStatus === 'failed') return { state: 'unavailable', phone: null, requestId, payload: data };
  if (!requestId) return { state: 'not_found', phone: null, requestId: '', payload: data };

  // Do not serialize multi-second polling inside each person hydration. The
  // sheet operator batches all pending request IDs after row processing.
  const polled = await pollPhoneRequest(requestId, { polls: 0 });
  return { ...polled, requestId, payload: polled.payload || data };
}

function pendingPhoneWaterfallRequestId(result = {}) {
  const direct = cacheEntryFor(result);
  const directRecord = direct.record || {};
  const directId = String(directRecord.threePocPhoneWaterfallRequestId || '').trim();
  if (directId && directRecord.threePocPhoneWaterfallStatus === 'pending') return directId;

  const wantedName = String(result?.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const wantedEmail = validBusinessEmail(result?.email || '');
  const wantedCompany = String(result?.organizationName || result?.company || '').trim();
  const wantedDomain = String(result?.organizationDomain || result?.domain || '').trim();
  if (!wantedName && !wantedEmail) return '';

  const cache = apollo.readCache();
  const matches = Object.values(cache.people || {}).filter((record) => {
    const requestId = String(record?.threePocPhoneWaterfallRequestId || '').trim();
    if (!requestId || record?.threePocPhoneWaterfallStatus !== 'pending') return false;
    if (wantedEmail && validBusinessEmail(record?.email || '') === wantedEmail) return true;
    const name = String(record?.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!wantedName || name !== wantedName) return false;
    if (!wantedCompany && !wantedDomain) return true;
    return apollo.sameOrganization(record, wantedCompany, wantedDomain);
  });
  return matches.length === 1 ? String(matches[0].threePocPhoneWaterfallRequestId || '').trim() : '';
}

async function improveVerifiedPhone(result) {
  if (!result || result.noMatch || result.ambiguous || result.identityVerified === false) return result;

  const immediate = apollo.validPhone(result.phone || '');
  if (immediate) return { ...result, phone: immediate, phoneStatus: 'found' };

  const found = cacheEntryFor(result);
  const record = found.record || {};
  const cachedPhone = apollo.validPhone(record.phone || '');
  if (cachedPhone) {
    runState.phoneWaterfallCacheHits++;
    return { ...result, phone: cachedPhone, phoneStatus: 'found', phoneWaterfallStatus: 'cached' };
  }

  const pendingId = String(record.threePocPhoneWaterfallRequestId || '').trim();
  if (pendingId && record.threePocPhoneWaterfallStatus === 'pending') {
    const polled = await pollPhoneRequest(pendingId, { polls: 0 });
    if (polled.state === 'found' && polled.phone) {
      runState.phoneWaterfallSucceeded++;
      apollo.recordPhoneResult(result?.apolloPersonId || result?.id, polled.phone);
      saveWaterfallState(result, {
        phone: polled.phone,
        phoneStatus: 'found',
        threePocPhoneWaterfallStatus: 'found',
        threePocPhoneWaterfallResolvedAt: new Date().toISOString(),
      });
      return { ...result, phone: polled.phone, phoneStatus: 'found', phoneWaterfallStatus: 'found' };
    }
    if (polled.state === 'pending') {
      runState.phoneWaterfallPending++;
      return {
        ...result,
        phoneStatus: 'waterfall_pending',
        phoneWaterfallPending: true,
        phoneWaterfallStatus: 'pending',
        phoneWaterfallRequestId: pendingId,
      };
    }
    if (polled.state === 'not_found' || polled.state === 'terminal') {
      runState.phoneWaterfallNotFound++;
      saveWaterfallState(result, {
        threePocPhoneWaterfallStatus: 'not_found',
        threePocPhoneWaterfallResolvedAt: new Date().toISOString(),
      });
      return { ...result, phoneWaterfallStatus: 'not_found' };
    }
    runState.phoneWaterfallErrors++;
    saveWaterfallState(result, {
      threePocPhoneWaterfallStatus: 'error',
      threePocPhoneWaterfallResolvedAt: new Date().toISOString(),
    });
    return { ...result, phoneWaterfallStatus: 'error' };
  }

  // Production mode uses Apollo's native reveal path. Existing already-paid
  // custom waterfall requests are still resumed above so migration is credit-safe.
  if (!phoneWaterfallEnabled()) return result;

  if (recentPhoneAttempt(record)) {
    runState.phoneWaterfallCooldownSkips++;
    return { ...result, phoneWaterfallStatus: record.threePocPhoneWaterfallStatus || 'cooldown' };
  }

  if (runState.phoneWaterfallStarted >= maxPhoneWaterfalls()) {
    runState.phoneWaterfallBudgetSkips++;
    return { ...result, phoneWaterfallStatus: 'budget_cap' };
  }

  runState.phoneWaterfallStarted++;
  saveWaterfallState(result, {
    threePocPhoneWaterfallAttemptedAt: new Date().toISOString(),
    threePocPhoneWaterfallStatus: 'starting',
  });

  try {
    const waterfall = await startPhoneWaterfall(result);
    if (waterfall.state === 'found' && waterfall.phone) {
      runState.phoneWaterfallSucceeded++;
      apollo.recordPhoneResult(result?.apolloPersonId || result?.id, waterfall.phone);
      saveWaterfallState(result, {
        phone: waterfall.phone,
        phoneStatus: 'found',
        threePocPhoneWaterfallRequestId: waterfall.requestId || null,
        threePocPhoneWaterfallStatus: 'found',
        threePocPhoneWaterfallResolvedAt: new Date().toISOString(),
      });
      return { ...result, phone: waterfall.phone, phoneStatus: 'found', phoneWaterfallStatus: 'found' };
    }

    if (waterfall.state === 'pending') {
      runState.phoneWaterfallPending++;
      saveWaterfallState(result, {
        threePocPhoneWaterfallRequestId: waterfall.requestId,
        threePocPhoneWaterfallStatus: 'pending',
      });
      return {
        ...result,
        phoneStatus: 'waterfall_pending',
        phoneWaterfallPending: true,
        phoneWaterfallStatus: 'pending',
        phoneWaterfallRequestId: waterfall.requestId,
      };
    }

    if (waterfall.state === 'unavailable') {
      runState.phoneWaterfallUnavailable++;
      saveWaterfallState(result, {
        threePocPhoneWaterfallRequestId: waterfall.requestId || null,
        threePocPhoneWaterfallStatus: 'unavailable',
        threePocPhoneWaterfallResolvedAt: new Date().toISOString(),
      });
      return { ...result, phoneWaterfallStatus: 'unavailable' };
    }

    if (waterfall.state === 'not_found' || waterfall.state === 'terminal') {
      runState.phoneWaterfallNotFound++;
      saveWaterfallState(result, {
        threePocPhoneWaterfallRequestId: waterfall.requestId || null,
        threePocPhoneWaterfallStatus: 'not_found',
        threePocPhoneWaterfallResolvedAt: new Date().toISOString(),
      });
      return { ...result, phoneWaterfallStatus: 'not_found' };
    }

    runState.phoneWaterfallErrors++;
    saveWaterfallState(result, {
      threePocPhoneWaterfallRequestId: waterfall.requestId || null,
      threePocPhoneWaterfallStatus: 'error',
    });
    return { ...result, phoneWaterfallStatus: 'error' };
  } catch {
    runState.phoneWaterfallErrors++;
    saveWaterfallState(result, { threePocPhoneWaterfallStatus: 'error' });
    return { ...result, phoneWaterfallStatus: 'error' };
  }
}

function recordPhoneWaterfallOutcome(identity = {}, outcome = {}) {
  const state = String(outcome?.state || '').trim().toLowerCase();
  const phone = apollo.validPhone(outcome?.phone || '');
  const result = {
    apolloPersonId: String(identity?.apolloPersonId || identity?.id || '').trim(),
    id: String(identity?.apolloPersonId || identity?.id || '').trim(),
    linkedinUrl: identity?.linkedinUrl || identity?.returnedLinkedIn || '',
  };

  if (phone) {
    apollo.recordPhoneResult(result.apolloPersonId, phone);
    saveWaterfallState(result, {
      phone,
      phoneStatus: 'found',
      threePocPhoneWaterfallStatus: 'found',
      threePocPhoneWaterfallResolvedAt: new Date().toISOString(),
    });
    return 'found';
  }

  if (state === 'not_found' || state === 'terminal' || state === 'unavailable') {
    saveWaterfallState(result, {
      threePocPhoneWaterfallStatus: state === 'unavailable' ? 'unavailable' : 'not_found',
      threePocPhoneWaterfallResolvedAt: new Date().toISOString(),
    });
    return state;
  }

  if (state === 'pending') {
    saveWaterfallState(result, {
      threePocPhoneWaterfallStatus: 'pending',
    });
    return 'pending';
  }

  if (state) {
    saveWaterfallState(result, {
      threePocPhoneWaterfallStatus: 'error',
      threePocPhoneWaterfallResolvedAt: new Date().toISOString(),
    });
  }
  return state || 'unknown';
}

async function improveVerifiedContacts(result, options = {}) {
  let next = result;
  // Phone is operationally higher-value for this lead workflow and the user
  // explicitly prioritizes filling missing numbers. Run it before optional email
  // deepening so an email waterfall cannot delay a useful phone result.
  if (options.needPhone !== false) next = await improveVerifiedPhone(next);
  if (options.needEmail !== false) next = await improveVerifiedEmail(next);
  return next;
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
    if (polled.state === 'not_found' || polled.state === 'terminal') {
      runState.waterfallNotFound++;
      saveWaterfallState(result, {
        threePocEmailWaterfallStatus: 'not_found',
        threePocEmailWaterfallResolvedAt: new Date().toISOString(),
      });
      return { ...result, emailWaterfallStatus: 'not_found' };
    }
    runState.waterfallErrors++;
    saveWaterfallState(result, {
      threePocEmailWaterfallStatus: 'error',
      threePocEmailWaterfallResolvedAt: new Date().toISOString(),
    });
    return { ...result, emailWaterfallStatus: 'error' };
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
  const originalResolvePersonByBusinessEmail = apollo.resolvePersonByBusinessEmail.bind(apollo);
  const originalResolvePersonProfile = apollo.resolvePersonProfile.bind(apollo);

  function baseOptionsForQuality(options = {}, identity = {}) {
    if (options.needPhone === false) return options;
    // Do not duplicate an already-paid legacy waterfall request during migration.
    // Otherwise native Apollo phone reveal is the production path.
    if (phoneWaterfallEnabled() || pendingPhoneWaterfallRequestId(identity)) {
      return { ...options, needPhone: false };
    }
    return options;
  }

  apollo.resolveDecisionMaker = async function resultsFirstResolveDecisionMaker(candidate, company, domain, options = {}) {
    const result = await originalResolveDecisionMaker(candidate, company, domain, baseOptionsForQuality(options, {
      ...candidate,
      organizationName: candidate?.organizationName || company,
      organizationDomain: candidate?.organizationDomain || domain,
    }));
    return improveVerifiedContacts(result, options);
  };

  apollo.resolvePersonByNameCompany = async function resultsFirstResolvePersonByNameCompany(name, company, domain, options = {}) {
    const result = await originalResolvePersonByNameCompany(name, company, domain, baseOptionsForQuality(options, {
      name,
      organizationName: company,
      organizationDomain: domain,
    }));
    return improveVerifiedContacts(result, options);
  };

  apollo.resolvePersonByBusinessEmail = async function resultsFirstResolvePersonByBusinessEmail(email, company, domain, options = {}) {
    const result = await originalResolvePersonByBusinessEmail(email, company, domain, baseOptionsForQuality(options, {
      email,
      organizationName: company,
      organizationDomain: domain,
    }));
    return improveVerifiedContacts(result, options);
  };

  // Exact LinkedIn anchors (POC-1 and any existing POC with a profile URL) must
  // use the same final-contact quality layer as name/company and business-email
  // resolution. Historically this path bypassed phone/email waterfalls entirely.
  apollo.resolvePersonProfile = async function resultsFirstResolvePersonProfile(linkedinUrl, options = {}) {
    const result = await originalResolvePersonProfile(linkedinUrl, baseOptionsForQuality(options, { linkedinUrl }));
    return improveVerifiedContacts(result, options);
  };

  const api = Object.freeze({
    startRun,
    stats,
    improveVerifiedEmail,
    improveVerifiedPhone,
    improveVerifiedContacts,
    recordPhoneWaterfallOutcome,
    maxWaterfalls,
    maxPhoneWaterfalls,
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
    phoneWaterfall: phoneWaterfallEnabled(),
    maxPhoneWaterfalls: maxPhoneWaterfalls(),
    phonePolls: phonePolls(),
    scope: 'final-verified-pocs-only',
  };
}

module.exports = {
  install,
  startRun,
  stats,
  improveVerifiedEmail,
  improveVerifiedPhone,
  improveVerifiedContacts,
  recordPhoneWaterfallOutcome,
  pendingPhoneWaterfallRequestId,
  emailFromPayload,
  phoneFromPayload,
  pollPhoneRequest,
  startPhoneWaterfall,
  requestIdFromRaw,
};
