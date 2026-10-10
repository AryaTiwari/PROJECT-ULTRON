'use strict';

// ---------------------------------------------------------------------------
// Shared explicit selection policy for phone-required enrichment.
//
// Two modes exist and they must never be silently mixed:
//
//   hiring-authority   choose the best verified hiring contact; a phone is only
//                      required when the task itself requires a phone.
//   phone-first-india  a usable verified phone is a HARD qualification; India
//                      numbers win; the international fallback is allowed only
//                      after five distinct India-focused search attempts have
//                      been completed without a qualifying Indian number.
//
// The mode is explicit task metadata (never inferred from a stale environment
// variable or an earlier mission). This module reuses the repository's existing
// India preference policy, phone validators, employer verification and
// contextual authority ranker instead of duplicating them.
// ---------------------------------------------------------------------------

const india = require('./india-preference-policy');
const contact = require('./apollo-contactability-policy');
const ranker = require('./universal-authority-ranker');
const pocSelector = require('./apollo-poc-selector');

const MODES = Object.freeze({
  HIRING_AUTHORITY: 'hiring-authority',
  PHONE_FIRST_INDIA: 'phone-first-india',
});

const OUTCOMES = Object.freeze({
  INDIAN_PHONE_SELECTED: 'INDIAN_PHONE_SELECTED',
  INTERNATIONAL_FALLBACK_SELECTED: 'INTERNATIONAL_FALLBACK_SELECTED',
  NO_VERIFIED_PHONE_AVAILABLE: 'NO_VERIFIED_PHONE_AVAILABLE',
  INDIA_SEARCH_INCOMPLETE: 'INDIA_SEARCH_INCOMPLETE',
  PHONE_REVEAL_PENDING: 'PHONE_REVEAL_PENDING',
  AMBIGUOUS_IDENTITY: 'AMBIGUOUS_IDENTITY',
  EMPLOYER_MISMATCH: 'EMPLOYER_MISMATCH',
});

// Contract: at most five distinct India-focused discovery attempts per company
// and enrichment target. Each entry is a genuinely different search strategy,
// not a rewording of the previous one.
const INDIA_ATTEMPT_LIMIT = 5;

const INDIA_SEARCH_STRATEGIES = Object.freeze([
  Object.freeze({
    id: 'india-ta-phone-capable',
    purpose: 'India-based recruiting/talent-acquisition contacts with direct-phone availability.',
    location: 'India',
    titles: Object.freeze(['recruiter', 'technical recruiter', 'talent acquisition recruiter', 'hr recruiter']),
  }),
  Object.freeze({
    id: 'india-hr-hiring-managers',
    purpose: 'India-based HR managers, HR business partners and hiring managers.',
    location: 'India',
    titles: Object.freeze(['hr manager', 'human resources manager', 'hiring manager', 'recruitment manager', 'hr business partner']),
  }),
  Object.freeze({
    id: 'india-ta-leadership',
    purpose: 'India-based recruiting leads, heads of talent and talent-acquisition leadership.',
    location: 'India',
    titles: Object.freeze(['head recruiter', 'recruitment head', 'talent acquisition lead', 'head of talent acquisition', 'head of people']),
  }),
  Object.freeze({
    id: 'india-domain-role-variants',
    purpose: 'Company-domain-constrained India search using broader role variants.',
    location: 'India',
    titles: Object.freeze(['talent acquisition specialist', 'people operations', 'staffing specialist', 'recruitment executive', 'hr executive']),
  }),
  Object.freeze({
    id: 'india-high-recall-broad',
    purpose: 'Final high-recall India-focused search with no title restriction.',
    location: 'India',
    titles: Object.freeze([]),
  }),
]);

function text(value) { return String(value == null ? '' : value).trim(); }
function digits(value) { return text(value).replace(/\D/g, ''); }

const NOT_A_PHONE = /^(?:null|none|n\/?a|unknown|not\s+found|unavailable|-+)$/i;

// The contactability policy owns the validity rule; this wrapper keeps the
// normalized value so callers can select and write the exact number.
function validPhone(value) {
  const raw = text(value);
  if (!raw || NOT_A_PHONE.test(raw)) return null;
  return contact.validPhone(raw) ? raw : null;
}

function personLocationText(person = {}) {
  return [
    person.country,
    person.country_name,
    person.city,
    person.state,
    person.location,
    person.raw_address,
    person.present_raw_address,
    person.organization?.country,
    person.organization?.state,
    person.organization?.city,
    person.organization?.raw_address,
  ].map(text).filter(Boolean).join(' ');
}

function phoneValue(person = {}) {
  return text(person.phone || person.phone_number || person.mobile_phone);
}

// A real Indian mobile needs explicit country evidence. A malformed "+91…"
// value is never an Indian number merely because it starts with +91.
function indianMobile(personOrPhone = {}, countryHint = '') {
  const value = typeof personOrPhone === 'string' || typeof personOrPhone === 'number'
    ? text(personOrPhone)
    : phoneValue(personOrPhone);
  if (!value) return '';
  const hint = text(countryHint) || (typeof personOrPhone === 'object' ? personLocationText(personOrPhone) : '');
  return india.strictIndianMobile(value, hint);
}

function indiaAddressed(value) {
  const raw = text(value);
  if (!raw) return false;
  const collapsed = raw.replace(/[\s()\-.]/g, '');
  if (/^\+91/.test(collapsed) || /^0091/.test(collapsed)) return true;
  const d = digits(collapsed);
  // A bare national-length number is only "India-addressed" together with
  // explicit country evidence; a +91/0091 country code always is.
  return false;
}

function phoneEvidence(person = {}) {
  const raw = phoneValue(person);
  const evidence = [];
  if (!raw) return { state: 'none', phone: null, indianPhone: null, reason: 'no-phone-value', evidence };
  const indian = indianMobile(person);
  if (indian) {
    evidence.push('strict-indian-mobile');
    if (india.isIndiaLocation(personLocationText(person))) evidence.push('india-location-evidence');
    return { state: 'indian-verified', phone: raw, indianPhone: indian, reason: 'verified-indian-mobile', evidence };
  }
  // A +91/0091 value that fails strict Indian-mobile validation is a malformed
  // Indian number, never a usable international fallback.
  if (indiaAddressed(raw)) {
    return { state: 'invalid', phone: null, indianPhone: null, reason: 'malformed-indian-number', evidence: ['india-country-code-without-valid-mobile'] };
  }
  const valid = validPhone(raw);
  if (!valid) {
    return { state: 'invalid', phone: null, indianPhone: null, reason: 'malformed-phone-value', evidence };
  }
  return { state: 'international-verified', phone: valid, indianPhone: null, reason: 'verified-international-phone', evidence };
}

function hasVerifiedPhone(person = {}) {
  const state = phoneEvidence(person).state;
  return state === 'indian-verified' || state === 'international-verified';
}

function hasVerifiedIndianPhone(person = {}) {
  return phoneEvidence(person).state === 'indian-verified';
}

function isIndiaEligible(person = {}) {
  return india.personIndiaPriority(person) > 0;
}

function directPhoneAvailability(person = {}) {
  const raw = text(
    person.hasDirectPhone
    ?? person.has_direct_phone
    ?? person.directPhoneAvailability
    ?? ''
  ).toLowerCase();
  if (!raw) return 0;
  if (/^(?:yes|true|available|found|confirmed|1)$/.test(raw)) return 2;
  if (/\b(?:yes|available|direct phone available)\b/.test(raw)) return 2;
  if (/\b(?:maybe|request direct dial|possible|potential|likely)\b/.test(raw)) return 1;
  return 0;
}

function phoneRevealPending(person = {}) {
  const status = text(person.phoneStatus || person.phone_status).toLowerCase();
  if (!['pending', 'waterfall_pending', 'in_progress'].includes(status)) return false;
  return Boolean(text(person.phoneRequestId || person.phoneWaterfallRequestId || person.requestId));
}

// --- identity + dedupe -----------------------------------------------------

function identityKeys(candidate = {}) {
  const keys = [];
  const id = text(candidate.apolloPersonId || candidate.id || candidate.person_id);
  if (id) keys.push(`apollo:${id.toLowerCase()}`);
  const linkedin = ranker.linkedinKey(candidate.linkedinUrl || candidate.linkedin_url || candidate.returnedLinkedIn || '');
  if (linkedin) keys.push(`linkedin:${linkedin}`);
  const email = text(candidate.email || candidate.work_email).toLowerCase();
  if (email) keys.push(`email:${email}`);
  const phone = digits(phoneValue(candidate));
  if (phone) keys.push(`phone:${phone}`);
  const name = ranker.normalize(candidate.name || candidate.full_name || '');
  const employer = ranker.companyKey(candidate.organizationName || candidate.organization_name || candidate.organization?.name || '');
  if (name && employer) keys.push(`person:${name}|${employer}`);
  return keys;
}

function dedupeCandidates(candidates = []) {
  const seen = new Set();
  const people = [];
  const duplicates = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const keys = identityKeys(candidate);
    if (!keys.length) { people.push(candidate); continue; }
    if (keys.some((key) => seen.has(key))) { duplicates.push(candidate); continue; }
    for (const key of keys) seen.add(key);
    people.push(candidate);
  }
  return { people, duplicates, deduped: duplicates.length };
}

// --- explicit mode metadata ------------------------------------------------

function normalizedMode(value) {
  const raw = text(value).toLowerCase().replace(/_/g, '-');
  if (!raw) return '';
  if (raw === MODES.PHONE_FIRST_INDIA || raw === 'phone-first' || raw === 'india-phone-first' || raw === 'phonefirst') return MODES.PHONE_FIRST_INDIA;
  if (raw === MODES.HIRING_AUTHORITY || raw === 'authority' || raw === 'hiring-authority-first') return MODES.HIRING_AUTHORITY;
  return '';
}

// Detect the two independent dimensions a request can express. They are kept
// separate on purpose: a task can require a usable phone without requiring an
// Indian number, and that must not silently acquire the five-attempt India
// budget or a hard India gate.
function detectRequestPolicy(value) {
  const raw = text(value);
  if (!raw) return { phoneRequired: false, indiaRequired: false };
  const phoneOutput = /\b(?:phone|phones|mobile|mobiles|mobile\s+numbers?|contact\s+numbers?|phone\s+numbers?|direct\s+dial)\b/i.test(raw)
    || /\b(?:\+?\s*91)[ -]?(?:\d{4,}|mobile|phone|number)/i.test(raw);
  const action = /\b(?:enrich|fill|find|get|look\s+up|obtain|collect|complete|missing|required?|needs?|with|add|append)\b/i.test(raw);
  const emailOnly = /\b(?:email|e-?mail)\s+(?:only|address)\b/i.test(raw) && !phoneOutput;
  if (emailOnly) return { phoneRequired: false, indiaRequired: false };
  const indiaEvidence = /\b(?:indian|india|\+\s*91)\b/i.test(raw)
    || /\b(?:indian|india)\s+(?:mobile|phone|number)/i.test(raw);
  const phoneRequired = phoneOutput && (action || indiaEvidence);
  return { phoneRequired, indiaRequired: phoneRequired && indiaEvidence };
}

function phoneFirstFromText(value) {
  const detected = detectRequestPolicy(value);
  return detected.phoneRequired && detected.indiaRequired;
}

function resolveMode(request = {}, options = {}) {
  const explicit = normalizedMode(options.policyMode ?? request.policyMode ?? options.selectionPolicy ?? request.selectionPolicy);
  if (explicit) {
    return Object.freeze({
      mode: explicit,
      requiresPhone: explicit === MODES.PHONE_FIRST_INDIA || options.requiresPhone === true || request.requiresPhone === true,
      indiaRequired: explicit === MODES.PHONE_FIRST_INDIA,
      source: 'explicit-metadata',
      explicit: true,
    });
  }
  const requestedGroups = Number(options.expectedPersonGroups || request.expectedPersonGroups || 0);
  if (options.requireIndianPhone === true || request.requireIndianPhone === true) {
    return Object.freeze({
      mode: MODES.PHONE_FIRST_INDIA,
      requiresPhone: true,
      indiaRequired: true,
      source: text(options.indianPhonePolicySource || request.indianPhonePolicySource) || 'require-indian-phone-gate',
      explicit: Boolean(options.indianPhonePolicySource || request.indianPhonePolicySource),
      requestedGroups: Number.isFinite(requestedGroups) ? requestedGroups : 0,
    });
  }
  const original = text(request.originalMessage || options.originalMessage || options.sourceText || '');
  const detected = detectRequestPolicy(original);
  if (detected.indiaRequired) {
    return Object.freeze({
      mode: MODES.PHONE_FIRST_INDIA,
      requiresPhone: true,
      indiaRequired: true,
      source: 'request-text-india-phone-required',
      explicit: false,
      requestedGroups: Number.isFinite(requestedGroups) ? requestedGroups : 0,
    });
  }
  return Object.freeze({
    mode: MODES.HIRING_AUTHORITY,
    requiresPhone: detected.phoneRequired || options.requiresPhone === true || request.requiresPhone === true,
    indiaRequired: false,
    source: detected.phoneRequired ? 'request-text-phone-required' : 'default',
    explicit: false,
    requestedGroups: Number.isFinite(requestedGroups) ? requestedGroups : 0,
  });
}

// --- policy version + cache isolation --------------------------------------

// Bump POLICY_VERSION whenever the qualification rules, the strategy list or the
// gated-fallback contract change. It is part of every cached discovery key, so a
// policy change invalidates older evidence instead of silently reusing candidate
// pools that were gathered under the previous rules.
const POLICY_VERSION = 'phone-first-india-v2';

function policyRulesSignature() {
  return [
    POLICY_VERSION,
    `india-attempt-limit:${INDIA_ATTEMPT_LIMIT}`,
    ...INDIA_SEARCH_STRATEGIES.map((strategy) => `${strategy.id}:${(strategy.titles || []).join('+')}`),
  ].join('|');
}

// Small deterministic hash (FNV-1a) so the fingerprint never depends on Node's
// crypto configuration and stays identical across processes and platforms.
function stableHash(value) {
  let hash = 0x811c9dc5;
  const source = String(value);
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function modeOf(value) {
  return normalizedMode(typeof value === 'object' ? value?.mode : value) || MODES.HIRING_AUTHORITY;
}

// Identity of the exact rule set a run executes under.
function policyFingerprint(value) {
  return `${POLICY_VERSION}:${modeOf(value)}:${stableHash(policyRulesSignature())}`;
}

// Discovery evidence is namespaced by policy identity: a pool gathered under one
// selection policy is never served to a run executing under another, and stale
// entries from an older rule set can never be read back.
function cacheNamespace(base, value) {
  return `${text(base) || 'discovery'}@${policyFingerprint(value)}`;
}

// --- resume-time policy continuity -----------------------------------------

// A mission records the policy it was approved and started under. Resuming is
// only safe while that policy still matches: hiring-authority and
// phone-first-india disagree about whether a usable phone is a hard
// qualification, so a mission approved under one must never silently continue
// under the other.
function policyConflict(mission = {}, resolved = {}) {
  const savedMode = text(mission?.policyMode);
  if (!savedMode) return { conflict: false, reason: 'legacy-mission-without-policy', fingerprint: policyFingerprint(resolved) };
  const savedFingerprint = `${POLICY_VERSION}:${modeOf(savedMode)}`;
  const currentFingerprint = `${POLICY_VERSION}:${modeOf(resolved)}`;
  if (savedFingerprint === currentFingerprint) {
    return {
      conflict: false,
      reason: 'policy-match',
      mode: modeOf(resolved),
      savedMode: modeOf(savedMode),
      currentMode: modeOf(resolved),
      fingerprint: currentFingerprint,
    };
  }
  return {
    conflict: true,
    code: 'UNIVERSAL_RESUME_POLICY_CHANGED',
    reason: 'saved-mission-policy-differs-from-requested-policy',
    savedMode: modeOf(savedMode),
    currentMode: modeOf(resolved),
    savedFingerprint,
    fingerprint: currentFingerprint,
    savedPolicySource: text(mission?.policySource) || null,
    savedIndiaRequired: Boolean(mission?.policyIndiaRequired),
    currentIndiaRequired: modeOf(resolved) === MODES.PHONE_FIRST_INDIA,
  };
}

function assertPolicyContinuity(mission = {}, resolved = {}) {
  const result = policyConflict(mission, resolved);
  if (!result.conflict) return result;
  throw Object.assign(
    new Error(`The saved mission was approved under the "${result.savedMode}" selection policy, but this resume resolves to "${result.currentMode}". Nothing was re-run or written. Reinspect and approve a new mission under the intended policy instead of changing policy mid-mission.`),
    {
      code: result.code,
      subsystem: 'POLICY',
      errorType: 'POLICY',
      errorStage: 'resume-policy-preflight',
      questions: [
        `The saved mission runs under "${result.savedMode}". Start a fresh enrichment run with the "${result.currentMode}" policy instead of resuming this mission.`,
      ],
      hint: 'Resume only under the policy the mission was approved with, or start a new mission.',
      diagnostics: result,
    },
  );
}

// --- five-attempt India search budget --------------------------------------

function attemptSignature(strategy = {}, companyKey = '') {
  const titles = (Array.isArray(strategy.titles) ? strategy.titles : []).map((title) => text(title).toLowerCase()).sort();
  return [
    text(companyKey || '*').toLowerCase(),
    text(strategy.location || 'India').toLowerCase(),
    text(strategy.id || 'unnamed'),
    titles.join(','),
  ].join('|');
}

function createIndiaSearchBudget(input = {}) {
  const limit = Math.max(1, Math.min(INDIA_ATTEMPT_LIMIT, Number(input.limit || INDIA_ATTEMPT_LIMIT)));
  const companyKey = text(input.companyKey || input.company || '').toLowerCase();
  const attempts = [];
  const signatures = new Set();
  let stoppedEarly = null;

  return Object.freeze({
    mode: MODES.PHONE_FIRST_INDIA,
    contract: 'five-distinct-india-attempts-before-international-fallback',
    companyKey,
    limit,
    get attempts() { return attempts.slice(); },
    attemptCount() { return attempts.length; },
    remaining() { return Math.max(0, limit - attempts.length); },
    exhausted() { return attempts.length >= limit; },
    stoppedEarly() { return stoppedEarly; },
    has(signature) { return signatures.has(text(signature)); },
    markStoppedEarly(reason) { if (!stoppedEarly) stoppedEarly = text(reason) || 'qualified-indian-phone-found'; return stoppedEarly; },
    record(entry = {}) {
      const signature = text(entry.signature) || attemptSignature(entry.strategy || entry, companyKey);
      if (signatures.has(signature)) return { counted: false, duplicate: true, attemptCount: attempts.length };
      if (attempts.length >= limit) return { counted: false, duplicate: false, exhausted: true, attemptCount: attempts.length };
      signatures.add(signature);
      attempts.push(Object.freeze({
        index: attempts.length + 1,
        strategyId: text(entry.strategyId || entry.strategy?.id) || `india-attempt-${attempts.length + 1}`,
        purpose: text(entry.purpose || entry.strategy?.purpose),
        signature,
        query: entry.query || null,
        outcome: text(entry.outcome) || 'completed',
        discovered: Number(entry.discovered || 0) || 0,
        durationMs: Number(entry.durationMs || 0) || 0,
        error: entry.error ? String(entry.error).slice(0, 300) : null,
      }));
      return { counted: true, duplicate: false, attemptCount: attempts.length };
    },
    summary() {
      return {
        mode: MODES.PHONE_FIRST_INDIA,
        companyKey,
        limit,
        attemptsUsed: attempts.length,
        attemptsRemaining: Math.max(0, limit - attempts.length),
        exhausted: attempts.length >= limit,
        stoppedEarly,
        strategyIds: attempts.map((attempt) => attempt.strategyId),
        attempts: attempts.map((attempt) => ({
          index: attempt.index,
          strategyId: attempt.strategyId,
          outcome: attempt.outcome,
          discovered: attempt.discovered,
          durationMs: attempt.durationMs,
          error: attempt.error,
        })),
      };
    },
  });
}

function internationalFallbackAllowed(input = {}) {
  const mode = normalizedMode(input.mode) || MODES.HIRING_AUTHORITY;
  if (mode !== MODES.PHONE_FIRST_INDIA) return true;
  const budget = input.budget;
  if (!budget || typeof budget.exhausted !== 'function') return false;
  return budget.exhausted();
}

function fallbackBlockReason(input = {}) {
  const budget = input.budget;
  if (!budget) return 'india-budget-not-started';
  if (!budget.exhausted()) return `india-budget-incomplete:${budget.attemptCount()}/${budget.limit}`;
  return '';
}

// Typed terminal status for a row/target where no in-run candidate qualified.
function exhaustedOutcome(input = {}) {
  const mode = normalizedMode(input.mode) || MODES.HIRING_AUTHORITY;
  const requiresPhone = Boolean(input.requiresPhone) || mode === MODES.PHONE_FIRST_INDIA;
  if (!requiresPhone) return { status: 'NO_QUALIFIED_CONTACT', reason: input.reason || 'no-qualified-candidate' };
  if (mode === MODES.PHONE_FIRST_INDIA && !internationalFallbackAllowed({ mode, budget: input.budget })) {
    return { status: OUTCOMES.INDIA_SEARCH_INCOMPLETE, reason: fallbackBlockReason({ mode, budget: input.budget }) || 'india-search-incomplete' };
  }
  return {
    status: OUTCOMES.NO_VERIFIED_PHONE_AVAILABLE,
    reason: input.reason || 'every-verified-candidate-lacked-a-valid-phone',
  };
}

// --- run state -------------------------------------------------------------

function percentile(values = [], p = 0.5) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function createLatencyRecorder() {
  const stages = new Map();
  return Object.freeze({
    record(stage, durationMs) {
      const name = text(stage) || 'unknown';
      const value = Number(durationMs);
      if (!Number.isFinite(value) || value < 0) return null;
      const bucket = stages.get(name) || [];
      bucket.push(value);
      stages.set(name, bucket);
      return value;
    },
    async time(stage, fn) {
      const started = Date.now();
      try { return await fn(); } finally { this.record(stage, Date.now() - started); }
    },
    summary() {
      const out = {};
      for (const [stage, values] of stages.entries()) {
        out[stage] = {
          samples: values.length,
          p50: percentile(values, 0.5),
          p95: percentile(values, 0.95),
          max: values.length ? Math.max(...values) : null,
          totalMs: values.reduce((sum, value) => sum + value, 0),
        };
      }
      return out;
    },
    stages() { return Object.freeze([...stages.keys()]); },
  });
}

function createRunState(modeInput, options = {}) {
  const mode = normalizedMode(typeof modeInput === 'object' ? modeInput?.mode : modeInput) || MODES.HIRING_AUTHORITY;
  const budgets = new Map();
  const latencies = createLatencyRecorder();
  return {
    mode,
    contract: 'explicit-policy-mode',
    requiresPhone: Boolean(options.requiresPhone) || mode === MODES.PHONE_FIRST_INDIA,
    indiaRequired: mode === MODES.PHONE_FIRST_INDIA,
    source: text(options.source) || 'run',
    createdAt: new Date().toISOString(),
    latencies,
    counters: {
      indiaSearchAttempts: 0,
      indiaSearchFailures: 0,
      indianNumbersFound: 0,
      internationalFallbacksUsed: 0,
      noVerifiedPhoneRows: 0,
      pendingRevealsStaged: 0,
      cacheHits: 0,
      cacheMisses: 0,
    },
    budgets,
    budgetFor(companyKey, company) {
      const key = text(companyKey || company).toLowerCase();
      if (!budgets.has(key)) budgets.set(key, createIndiaSearchBudget({ companyKey: key, company }));
      return budgets.get(key);
    },
    recordCounter(name, delta = 1) {
      const key = text(name);
      if (!key) return;
      this.counters[key] = Number(this.counters[key] || 0) + Number(delta || 0);
    },
  };
}

function latencySummary(runState) {
  if (!runState?.latencies) return {};
  return runState.latencies.summary();
}

function maskPhone(value) {
  const raw = text(value);
  if (!raw) return '';
  const d = digits(raw);
  if (d.length <= 4) return '****';
  return `${raw.startsWith('+') ? '+' : ''}${raw.replace(/\D/g, '').slice(0, 2)}******${d.slice(-4)}`;
}

// --- discovery fan-out -----------------------------------------------------

async function discoverIndiaPeople(input = {}) {
  const search = input.search;
  if (typeof search !== 'function') throw new TypeError('discoverIndiaPeople requires a search function.');
  const budget = input.budget || createIndiaSearchBudget({ companyKey: input.companyKey || input.companyContext?.company });
  const companyContext = input.companyContext || {};
  const company = text(companyContext.company || input.company);
  const domain = text(companyContext.domain || input.domain);
  const limit = Math.max(3, Math.min(60, Number(input.limit || 30)));
  const hasIndianPhone = typeof input.hasIndianPhone === 'function' ? input.hasIndianPhone : () => false;
  const strategies = (Array.isArray(input.strategies) && input.strategies.length ? input.strategies : INDIA_SEARCH_STRATEGIES)
    .slice(0, INDIA_ATTEMPT_LIMIT);
  const onAttempt = typeof input.onAttempt === 'function' ? input.onAttempt : () => {};
  const settledMap = input.settledMap || require('./universal-run-context').settledMap;
  const concurrency = Math.max(1, Math.min(3, Number(input.concurrency || 2)));

  const collected = [];
  const attempted = [];
  let stoppedEarly = budget.stoppedEarly ? budget.stoppedEarly() : null;

  const pending = strategies.filter((strategy) => {
    if (budget.exhausted()) return false;
    if (budget.has(attemptSignature(strategy, budget.companyKey))) return false;
    return true;
  });

  // Bounded parallel batches: a batch runs at most `concurrency` distinct
  // strategies, then the early-stop check happens before the next batch.
  for (let index = 0; index < pending.length; index += concurrency) {
    if (budget.exhausted()) break;
    if (stoppedEarly || hasIndianPhone(collected)) { budget.markStoppedEarly('qualified-indian-phone-available'); stoppedEarly = budget.stoppedEarly(); break; }
    const batch = pending.slice(index, index + concurrency);
    const results = await settledMap(batch, async (strategy) => {
      const started = Date.now();
      const signature = attemptSignature(strategy, budget.companyKey);
      const query = { company, domain, location: strategy.location || 'India', titles: strategy.titles, limit };
      try {
        const result = await search({ ...query, strategyId: strategy.id });
        const people = Array.isArray(result?.people) ? result.people : [];
        budget.record({ strategy, signature, query, outcome: 'completed', discovered: people.length, durationMs: Date.now() - started });
        return { strategy, people, durationMs: Date.now() - started, error: null };
      } catch (error) {
        budget.record({
          strategy,
          signature,
          query,
          outcome: 'failed',
          discovered: 0,
          durationMs: Date.now() - started,
          error: error?.message || error,
        });
        return { strategy, people: [], durationMs: Date.now() - started, error };
      }
    }, concurrency);

    for (const entry of results) {
      const value = entry?.status === 'fulfilled' ? entry.value : null;
      if (!value) continue;
      attempted.push({
        strategyId: value.strategy?.id || '',
        purpose: value.strategy?.purpose || '',
        discovered: value.people.length,
        durationMs: value.durationMs,
        outcome: value.error ? 'failed' : 'completed',
        error: value.error ? String(value.error?.message || value.error).slice(0, 300) : null,
      });
      onAttempt(attempted[attempted.length - 1]);
      if (value.error) continue;
      if (value.people.length) collected.push(...value.people);
    }
    if (hasIndianPhone(collected)) { budget.markStoppedEarly('qualified-indian-phone-available'); stoppedEarly = budget.stoppedEarly(); break; }
  }

  const deduped = dedupeCandidates(collected);
  return {
    people: deduped.people,
    duplicates: deduped.duplicates,
    attempts: attempted,
    stoppedEarly,
    exhausted: budget.exhausted(),
    remaining: budget.remaining(),
    strategiesPlanned: strategies.map((strategy) => strategy.id),
    strategiesRun: attempted.map((attempt) => attempt.strategyId),
    budget: budget.summary(),
  };
}

// --- selection -------------------------------------------------------------

function employerEvidence(person = {}, company = {}) {
  return {
    verified: pocSelector.employerVerified(person, company),
    domain: ranker.sameEmployer(person, company),
  };
}

// The repository's own decision ladder (apollo-poc-selector) is the authority
// key; the contextual hiring-authority ranker supplies the tiebreak from
// company-size, function, seniority and role evidence. Phone availability is a
// separate HARD qualification enforced by the caller, so a more senior person
// without a valid number can never beat a verified contact with one.
function authorityLadder(person = {}) {
  const title = text(person.title || person.headline || person.designation || '');
  const tier = Number(pocSelector.tier(title, 1));
  return Number.isFinite(tier) && tier > 0 ? tier : 99;
}

function bestByAuthority(pool = [], context = {}, options = {}) {
  if (!pool.length) return null;
  const ranked = ranker.rankCandidates(pool, context, { minimumScore: Number(options.minimumScore ?? 0) });
  const scores = new Map(ranked.ranked.map((item) => [item.candidate, item]));
  const ordered = [...pool].sort((a, b) =>
    authorityLadder(a) - authorityLadder(b)
    || Number(scores.get(b)?.score || 0) - Number(scores.get(a)?.score || 0)
    || String(a.name || '').localeCompare(String(b.name || '')));
  const top = ordered[0];
  const evidence = scores.get(top);
  return {
    person: top,
    score: evidence?.score ?? 0,
    confidence: evidence?.confidence ?? 0,
    proof: evidence?.proof ?? [],
    method: evidence ? 'decision-ladder+contextual-rank' : 'decision-ladder',
  };
}

function selectPhoneFirst(input = {}) {
  const mode = normalizedMode(input.mode) || MODES.HIRING_AUTHORITY;
  const company = input.company || {};
  const budget = input.budget || null;
  const context = input.context || {};
  const requiresPhone = Boolean(input.requiresPhone) || mode === MODES.PHONE_FIRST_INDIA;
  const deduped = dedupeCandidates(input.candidates || []);
  const diagnostics = {
    mode,
    requiresPhone,
    discovered: (Array.isArray(input.candidates) ? input.candidates.length : 0),
    deduplicated: deduped.deduped,
    employerVerified: 0,
    employerRejected: 0,
    indianQualified: 0,
    internationalQualified: 0,
    malformedPhones: 0,
    noPhone: 0,
    pendingReveals: 0,
    indiaAttemptsUsed: budget && typeof budget.attemptCount === 'function' ? budget.attemptCount() : 0,
    indiaAttemptsRemaining: budget && typeof budget.remaining === 'function' ? budget.remaining() : null,
    internationalFallbackAllowed: internationalFallbackAllowed({ mode, budget }),
    fallbackBlockedReason: fallbackBlockReason({ mode, budget }),
  };

  const verified = [];
  for (const person of deduped.people) {
    const evidence = employerEvidence(person, company);
    if (!evidence.verified) {
      diagnostics.employerRejected++;
      continue;
    }
    diagnostics.employerVerified++;
    verified.push(person);
  }

  const indianPool = [];
  const internationalPool = [];
  const pendingPool = [];
  for (const person of verified) {
    const phone = phoneEvidence(person);
    if (phone.state === 'indian-verified') { indianPool.push(person); continue; }
    if (phone.state === 'invalid') diagnostics.malformedPhones++;
    if (phone.state === 'none') diagnostics.noPhone++;
    if (phone.state === 'international-verified') internationalPool.push(person);
    if (phoneRevealPending(person)) pendingPool.push(person);
  }
  diagnostics.indianQualified = indianPool.length;
  diagnostics.internationalQualified = internationalPool.length;
  diagnostics.pendingReveals = pendingPool.length;

  const pick = (pool) => bestByAuthority(pool, context, input);
  const outcome = (status, selection, reason, extra = {}) => Object.freeze({
    status,
    reason,
    mode,
    requiresPhone,
    selected: selection || null,
    selection,
    diagnostics: Object.freeze({ ...diagnostics, ...extra }),
  });

  if (indianPool.length) {
    return outcome(OUTCOMES.INDIAN_PHONE_SELECTED, pick(indianPool), 'verified-indian-mobile');
  }

  // No Indian number anywhere. Never spend the international fallback before the
  // five distinct India attempts are complete in phone-first mode.
  if (mode === MODES.PHONE_FIRST_INDIA && !internationalFallbackAllowed({ mode, budget })) {
    if (pendingPool.length) {
      return outcome(OUTCOMES.PHONE_REVEAL_PENDING, null, 'india-search-incomplete-and-phone-reveal-pending', {
        fallbackBlockedReason: fallbackBlockReason({ mode, budget }),
      });
    }
    return outcome(OUTCOMES.INDIA_SEARCH_INCOMPLETE, null, fallbackBlockReason({ mode, budget }) || 'india-search-incomplete');
  }

  if (internationalPool.length) {
    return outcome(
      OUTCOMES.INTERNATIONAL_FALLBACK_SELECTED,
      pick(internationalPool),
      mode === MODES.PHONE_FIRST_INDIA ? 'india-budget-exhausted-international-fallback' : 'authority-selected-with-valid-phone',
    );
  }

  if (pendingPool.length) {
    return outcome(OUTCOMES.PHONE_REVEAL_PENDING, null, 'phone-reveal-pending');
  }

  // Nothing qualified. Distinguish no-eligible-people from people-without-phones.
  return outcome(OUTCOMES.NO_VERIFIED_PHONE_AVAILABLE, null, diagnostics.employerVerified === 0
    ? 'no-employer-verified-candidate'
    : 'every-verified-candidate-lacked-a-valid-phone');
}

function summarize(runState) {
  if (!runState) return {};
  const budgets = [...(runState.budgets instanceof Map ? runState.budgets.values() : [])].map((budget) => budget.summary());
  return {
    mode: runState.mode,
    contract: runState.contract,
    requiresPhone: Boolean(runState.requiresPhone),
    indiaRequired: Boolean(runState.indiaRequired),
    source: runState.source,
    counters: { ...runState.counters },
    indiaBudgets: budgets,
    latency: latencySummary(runState),
  };
}

function humanSummary(runState) {
  const summary = summarize(runState);
  const indiaAttempts = summary.indiaBudgets.reduce((sum, item) => sum + Number(item.attemptsUsed || 0), 0);
  const lines = [
    `Policy mode: ${summary.mode}${summary.indiaRequired ? ' (India phone required)' : ''}.`,
    `India search attempts used: ${indiaAttempts} of ${summary.indiaBudgets.length * INDIA_ATTEMPT_LIMIT}.`,
    `Indian numbers written: ${summary.counters.indianNumbersFound}; international fallbacks written: ${summary.counters.internationalFallbacksUsed}; rows without a valid phone: ${summary.counters.noVerifiedPhoneRows}; pending reveals: ${summary.counters.pendingRevealsStaged}.`,
    `Discovery cache hits: ${summary.counters.cacheHits}; misses: ${summary.counters.cacheMisses}.`,
  ];
  return lines.join(' ');
}

const INSTALL_FLAG = Symbol.for('ultron.mark3.universalPhoneFirstPolicy.installed');

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];
  const api = Object.freeze({
    MODES,
    OUTCOMES,
    INDIA_ATTEMPT_LIMIT,
    INDIA_SEARCH_STRATEGIES,
    POLICY_VERSION,
    policyFingerprint,
    cacheNamespace,
    policyConflict,
    assertPolicyContinuity,
    resolveMode,
    createIndiaSearchBudget,
    createRunState,
    createLatencyRecorder,
    discoverIndiaPeople,
    selectPhoneFirst,
    internationalFallbackAllowed,
    fallbackBlockReason,
    dedupeCandidates,
    identityKeys,
    phoneEvidence,
    indianMobile,
    validPhone,
    hasVerifiedPhone,
    hasVerifiedIndianPhone,
    isIndiaEligible,
    directPhoneAvailability,
    phoneRevealPending,
    attemptSignature,
    percentile,
    maskPhone,
    summarize,
    humanSummary,
    deterministic: true,
    modelCalls: 0,
  });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

module.exports = {
  MODES,
  OUTCOMES,
  INDIA_ATTEMPT_LIMIT,
  INDIA_SEARCH_STRATEGIES,
  POLICY_VERSION,
  policyFingerprint,
  cacheNamespace,
  policyConflict,
  assertPolicyContinuity,
  resolveMode,
  detectRequestPolicy,
  phoneFirstFromText,
  createIndiaSearchBudget,
  createRunState,
  createLatencyRecorder,
  discoverIndiaPeople,
  selectPhoneFirst,
  internationalFallbackAllowed,
  fallbackBlockReason,
  exhaustedOutcome,
  dedupeCandidates,
  identityKeys,
  phoneEvidence,
  indianMobile,
  validPhone,
  hasVerifiedPhone,
  hasVerifiedIndianPhone,
  isIndiaEligible,
  directPhoneAvailability,
  phoneRevealPending,
  attemptSignature,
  percentile,
  maskPhone,
  summarize,
  humanSummary,
  install,
};
