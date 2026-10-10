'use strict';

// ---------------------------------------------------------------------------
// Phone-first enrichment policy regression suite.
//
// Contract under test:
//   1. The selection policy mode is explicit task metadata (never inferred from
//      a stale environment variable, an earlier mission or unrelated text).
//   2. phone-first-india requires a valid phone as a HARD qualification, prefers
//      a verified Indian mobile, and unlocks the international fallback ONLY
//      after five distinct India-focused attempts have completed.
//   3. A malformed +91 value is never an Indian number and never a usable
//      international number; a bare 10-digit value is not assumed Indian
//      without country evidence.
//   4. Nothing is written when no candidate has a valid phone, and identity is
//      deduplicated so the same person is never purchased twice.
//
// Every provider call in this suite is a deterministic local mock. No Apollo,
// Google Sheets, LinkedIn or AI call is made and no credit is consumed.
// ---------------------------------------------------------------------------

// Keep this suite hermetic: durable discovery evidence goes to a throwaway
// store so the real .ultron cache is never read or mutated by a test run.
const os = require('os');
const nodeFs = require('fs');
const nodePath = require('path');
const scratchDir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'ultron-phone-first-'));
process.env.ULTRON_M3_ENRICHMENT_CACHE_STORE = nodePath.join(scratchDir, 'cache.json');

const assert = require('assert/strict');
const policy = require('../core/universal-phone-first-policy');
const operator = require('../core/universal-sheet-enrichment-operator');
const apolloModule = require('../core/apollo-enrichment');
const ranker = require('../core/universal-authority-ranker');
const durableCache = require('../core/universal-enrichment-cache');

const TOTAL = 26;
const queue = [];

// Tests are queued and executed in declaration order by runSuite(), so async
// cases stay readable next to synchronous ones without top-level await.
function test(label, fn) { queue.push({ label, fn }); }
function testAsync(label, fn) { queue.push({ label, fn }); }

async function runSuite() {
  for (const [index, item] of queue.entries()) {
    const label = `${String(index + 1).padStart(2, '0')}/${TOTAL} ${item.label}`;
    try {
      await item.fn();
      console.log(`TEST ${label} OK`);
    } catch (error) {
      console.error(`TEST ${label} FAILED`);
      console.error((error && error.stack) || error);
      process.exitCode = 1;
      return;
    }
  }
  if (queue.length !== TOTAL) {
    console.error(`expected ${TOTAL} tests, ran ${queue.length}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nuniversal-phone-first-policy-selftest: ${TOTAL}/${TOTAL} passed (mocked providers, no live calls, no credits).`);
}

const ACME = { name: 'Acme Systems', domain: 'acme.example' };

function person(extra = {}) {
  return {
    apolloPersonId: extra.apolloPersonId || `p-${Math.random().toString(36).slice(2, 8)}`,
    name: extra.name || 'Person',
    title: extra.title || 'Recruiter',
    organizationName: extra.organizationName ?? ACME.name,
    organizationDomain: extra.organizationDomain ?? ACME.domain,
    apolloSearchEmployerVerified: true,
    ...extra,
  };
}

function fullBudget() {
  // A budget that has completed all five distinct India attempts.
  const budget = policy.createIndiaSearchBudget({ companyKey: 'acme systems' });
  for (const strategy of policy.INDIA_SEARCH_STRATEGIES) {
    budget.record({ strategy, signature: policy.attemptSignature(strategy, 'acme systems') });
  }
  assert.equal(budget.exhausted(), true);
  return budget;
}

// --- 1. explicit policy mode -------------------------------------------------

test('policy mode is explicit metadata, not inferred from unrelated text', () => {
  assert.equal(policy.resolveMode({ policyMode: 'phone-first-india' }, {}).mode, policy.MODES.PHONE_FIRST_INDIA);
  assert.equal(policy.resolveMode({ policyMode: 'hiring-authority' }, {}).mode, policy.MODES.HIRING_AUTHORITY);
  assert.equal(policy.resolveMode({}, {}).mode, policy.MODES.HIRING_AUTHORITY);
  assert.equal(policy.resolveMode({}, {}).requiresPhone, false);

  // An explicit mode beats any conflicting text or stale gate flag.
  const explicit = policy.resolveMode({ policyMode: 'hiring-authority', requireIndianPhone: true }, {});
  assert.equal(explicit.mode, policy.MODES.HIRING_AUTHORITY);

  // A phone-required task without India evidence needs a phone but must NOT
  // silently acquire the five-attempt India budget / hard India gate.
  const plainPhone = policy.resolveMode({ originalMessage: 'Fill the missing phone numbers for these contacts.' }, {});
  assert.equal(plainPhone.mode, policy.MODES.HIRING_AUTHORITY);
  assert.equal(plainPhone.requiresPhone, true);
  assert.equal(plainPhone.indiaRequired, false);

  // Explicit India phone requirement does select phone-first-india.
  const indiaPhone = policy.resolveMode({ originalMessage: 'Find Indian mobile numbers for POC-1 and POC-2.' }, {});
  assert.equal(indiaPhone.mode, policy.MODES.PHONE_FIRST_INDIA);
  assert.equal(indiaPhone.indiaRequired, true);

  // The existing approval gate flag still selects the same mode.
  const gated = policy.resolveMode({ requireIndianPhone: true, indianPhonePolicySource: 'automatic-poc1-poc2-default' }, {});
  assert.equal(gated.mode, policy.MODES.PHONE_FIRST_INDIA);
  assert.equal(gated.source, 'automatic-poc1-poc2-default');
});

// --- 2. phone evidence -------------------------------------------------------

test('a verified Indian number qualifies and is normalized', () => {
  const evidence = policy.phoneEvidence(person({ phone: '+91 98765 43210', country: 'India' }));
  assert.equal(evidence.state, 'indian-verified');
  assert.equal(evidence.indianPhone, '+919876543210');
});

test('a malformed +91 value is neither Indian nor a usable international number', () => {
  for (const value of ['+91 12345', '+911234567890', '+91 00000 00000', '+91999999999']) {
    const evidence = policy.phoneEvidence(person({ phone: value, country: 'India' }));
    assert.equal(evidence.state, 'invalid', `${value} must be invalid`);
    assert.equal(evidence.indianPhone, null, `${value} must not be an Indian number`);
    assert.equal(evidence.phone, null, `${value} must not be written`);
  }
});

test('a bare 10-digit number is not assumed Indian without country evidence', () => {
  const noEvidence = policy.phoneEvidence(person({ phone: '9876543210', country: 'United States' }));
  assert.equal(noEvidence.state, 'international-verified');
  assert.equal(noEvidence.indianPhone, null);

  const withEvidence = policy.phoneEvidence(person({ phone: '9876543210', country: 'India' }));
  assert.equal(withEvidence.state, 'indian-verified');
  assert.equal(withEvidence.indianPhone, '+919876543210');

  const unknown = policy.phoneEvidence(person({ phone: '9876543210' }));
  assert.notEqual(unknown.state, 'indian-verified');
  assert.equal(unknown.state, 'international-verified');

  // With no country evidence at all the value is not silently upgraded.
  assert.equal(policy.phoneEvidence(person({})).state, 'none');
  assert.equal(policy.phoneEvidence(person({ phone: 'N/A' })).state, 'invalid');
});

test('phone classification drives the run counters', () => {
  const state = policy.createRunState(policy.MODES.PHONE_FIRST_INDIA, { requiresPhone: true });
  const indian = policy.phoneEvidence(person({ phone: '+919876543210', country: 'India' }));
  const international = policy.phoneEvidence(person({ phone: '+14155552671', country: 'United States' }));
  if (indian.state === 'indian-verified') state.recordCounter('indianNumbersFound');
  if (international.state === 'international-verified') state.recordCounter('internationalFallbacksUsed');
  const summary = policy.summarize(state);
  assert.equal(summary.mode, policy.MODES.PHONE_FIRST_INDIA);
  assert.equal(summary.counters.indianNumbersFound, 1);
  assert.equal(summary.counters.internationalFallbacksUsed, 1);
  assert.match(policy.humanSummary(state), /Policy mode: phone-first-india/);
});

// --- 3. budget contract ------------------------------------------------------

test('exactly five distinct India strategies, and duplicates never double-count', () => {
  assert.equal(policy.INDIA_SEARCH_STRATEGIES.length, 5);
  assert.equal(new Set(policy.INDIA_SEARCH_STRATEGIES.map((item) => item.id)).size, 5);
  const budget = policy.createIndiaSearchBudget({ companyKey: 'acme' });
  assert.equal(budget.limit, policy.INDIA_ATTEMPT_LIMIT);

  const first = budget.record({ strategy: policy.INDIA_SEARCH_STRATEGIES[0] });
  assert.equal(first.counted, true);
  const duplicate = budget.record({ strategy: policy.INDIA_SEARCH_STRATEGIES[0] });
  assert.equal(duplicate.counted, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(budget.attemptCount(), 1);

  // A signalled early stop never fabricates an attempt count.
  budget.markStoppedEarly('verified-indian-phone-found');
  assert.equal(budget.stoppedEarly(), 'verified-indian-phone-found');
  assert.equal(budget.attemptCount(), 1);
});

test('the international fallback stays locked until five India attempts complete', () => {
  const partial = policy.createIndiaSearchBudget({ companyKey: 'acme' });
  partial.record({ strategy: policy.INDIA_SEARCH_STRATEGIES[0] });
  assert.equal(policy.internationalFallbackAllowed({ mode: policy.MODES.PHONE_FIRST_INDIA, budget: partial }), false);
  assert.match(policy.fallbackBlockReason({ budget: partial }), /india-budget-incomplete:1\/5/);

  const complete = fullBudget();
  assert.equal(policy.internationalFallbackAllowed({ mode: policy.MODES.PHONE_FIRST_INDIA, budget: complete }), true);

  // A non-India mode is never gated by the India budget.
  assert.equal(policy.internationalFallbackAllowed({ mode: policy.MODES.HIRING_AUTHORITY, budget: null }), true);
  // A phone-first run without a started budget is closed, not open.
  assert.equal(policy.internationalFallbackAllowed({ mode: policy.MODES.PHONE_FIRST_INDIA, budget: null }), false);
});

test('the India plan never exceeds the five-attempt cap', () => {
  const budget = policy.createIndiaSearchBudget({ companyKey: 'acme' });
  for (let index = 0; index < 9; index++) {
    budget.record({
      strategy: { id: `extra-${index}`, titles: [`title ${index}`] },
      signature: `acme|india|extra-${index}|title ${index}`,
    });
  }
  assert.equal(budget.attemptCount(), 5);
  assert.equal(budget.exhausted(), true);
  assert.equal(budget.remaining(), 0);
});

// --- 4. discovery fan-out (mocked provider) ---------------------------------

testAsync('the India plan issues five distinct searches and dedupes people', async () => {
  const queries = [];
  const budget = policy.createIndiaSearchBudget({ companyKey: 'acme' });
  const result = await policy.discoverIndiaPeople({
    search: async (query) => {
      queries.push(query);
      // Every strategy returns the same two people plus one new person: the
      // shared identities must be deduplicated.
      return { people: [
        person({ apolloPersonId: 'shared-1', name: 'Shared One', title: 'HR Manager' }),
        person({ apolloPersonId: 'shared-2', name: 'Shared Two', title: 'Recruiter' }),
        person({ apolloPersonId: `only-${query.strategyId}`, name: `Only ${query.strategyId}` }),
      ] };
    },
    companyContext: ACME,
    budget,
    concurrency: 2,
  });

  assert.equal(result.attempts.length, 5);
  assert.equal(budget.attemptCount(), 5);
  assert.equal(result.exhausted, true);
  assert.equal(queries.length, 5);
  assert.equal(new Set(queries.map((query) => query.strategyId)).size, 5);
  for (const query of queries) assert.equal(query.location, 'India');
  // 2 shared + 5 unique = 7 unique identities.
  assert.equal(result.people.length, 7);
  assert.equal(result.duplicates.length, 8);
  assert.deepEqual(result.strategiesRun, policy.INDIA_SEARCH_STRATEGIES.map((item) => item.id));
});

testAsync('the India plan stops issuing new searches once a verified Indian number exists', async () => {
  const queries = [];
  const budget = policy.createIndiaSearchBudget({ companyKey: 'acme' });
  let indianFound = false;
  const result = await policy.discoverIndiaPeople({
    search: async (query) => {
      queries.push(query);
      indianFound = true;
      return { people: [person({ apolloPersonId: `found-${query.strategyId}`, phone: '+919876543210', country: 'India' })] };
    },
    companyContext: ACME,
    budget,
    concurrency: 1,
    hasIndianPhone: () => indianFound,
  });

  assert.equal(result.stoppedEarly, 'qualified-indian-phone-available');
  assert.equal(budget.stoppedEarly(), 'qualified-indian-phone-available');
  assert.ok(queries.length < 5, `expected early stop, ran ${queries.length} searches`);
  assert.ok(budget.attemptCount() < 5);
  assert.equal(policy.internationalFallbackAllowed({ mode: policy.MODES.PHONE_FIRST_INDIA, budget }), false);
});

testAsync('a failed India strategy is recorded as a failure, not as a negative no-result', async () => {
  const budget = policy.createIndiaSearchBudget({ companyKey: 'acme' });
  const failures = [];
  const result = await policy.discoverIndiaPeople({
    search: async (query) => {
      if (query.strategyId === policy.INDIA_SEARCH_STRATEGIES[0].id) {
        const error = new Error('Apollo rate limited');
        error.code = 'APOLLO_RATE_LIMITED';
        throw error;
      }
      return { people: [] };
    },
    companyContext: ACME,
    budget,
    concurrency: 2,
    onAttempt: (attempt) => { if (attempt.outcome === 'failed') failures.push(attempt); },
  });

  assert.equal(failures.length, 1);
  assert.equal(failures[0].strategyId, policy.INDIA_SEARCH_STRATEGIES[0].id);
  assert.match(failures[0].error, /rate limited/i);
  // A transient provider failure still consumed one of the five distinct
  // attempts, so the budget stays honest.
  assert.equal(budget.attemptCount(), 5);
  assert.equal(result.attempts.filter((attempt) => attempt.outcome === 'failed').length, 1);
  // The failure was never cached as "this company has no India contact".
  assert.equal(budget.summary().attempts.find((attempt) => attempt.outcome === 'failed').discovered, 0);
});

// --- 5. selection contract ---------------------------------------------------

test('a verified Indian number wins over a higher-authority international number', () => {
  const outcome = policy.selectPhoneFirst({
    mode: policy.MODES.PHONE_FIRST_INDIA,
    requiresPhone: true,
    company: ACME,
    budget: policy.createIndiaSearchBudget({ companyKey: 'acme' }),
    candidates: [
      person({ apolloPersonId: 'intl-ceo', name: 'Intl Founder', title: 'Founder', phone: '+14155552671', country: 'United States' }),
      person({ apolloPersonId: 'in-hr', name: 'Indian Recruiter', title: 'Recruiter', phone: '+919876543210', country: 'India' }),
    ],
  });
  assert.equal(outcome.status, policy.OUTCOMES.INDIAN_PHONE_SELECTED);
  assert.equal(outcome.selected.person.name, 'Indian Recruiter');
  assert.equal(outcome.diagnostics.indianQualified, 1);
  assert.equal(outcome.diagnostics.internationalFallbackAllowed, false);
});

test('no international fallback before five India attempts, then highest authority wins', () => {
  const candidates = [
    person({ apolloPersonId: 'intl-recruiter', name: 'Intl Recruiter', title: 'Recruiter', phone: '+14155552671', country: 'United States' }),
    person({ apolloPersonId: 'intl-director', name: 'Intl Director', title: 'Director', phone: '+14155552672', country: 'United States' }),
  ];

  const blocked = policy.selectPhoneFirst({
    mode: policy.MODES.PHONE_FIRST_INDIA,
    requiresPhone: true,
    company: ACME,
    budget: policy.createIndiaSearchBudget({ companyKey: 'acme' }),
    candidates,
  });
  assert.equal(blocked.status, policy.OUTCOMES.INDIA_SEARCH_INCOMPLETE);
  assert.equal(blocked.selected, null);
  assert.match(blocked.diagnostics.fallbackBlockedReason, /india-budget-incomplete/);

  const allowed = policy.selectPhoneFirst({
    mode: policy.MODES.PHONE_FIRST_INDIA,
    requiresPhone: true,
    company: ACME,
    budget: fullBudget(),
    candidates,
  });
  assert.equal(allowed.status, policy.OUTCOMES.INTERNATIONAL_FALLBACK_SELECTED);
  assert.equal(allowed.selected.person.name, 'Intl Director');
  assert.equal(allowed.diagnostics.internationalFallbackAllowed, true);
});

test('a candidate without a valid phone is never selected in a phone-required run', () => {
  const outcome = policy.selectPhoneFirst({
    mode: policy.MODES.PHONE_FIRST_INDIA,
    requiresPhone: true,
    company: ACME,
    budget: fullBudget(),
    candidates: [
      person({ apolloPersonId: 'no-phone-founder', name: 'No Phone Founder', title: 'Founder' }),
      person({ apolloPersonId: 'bad-phone', name: 'Bad Phone', title: 'HR Manager', phone: '+91 12345' }),
    ],
  });
  assert.equal(outcome.status, policy.OUTCOMES.NO_VERIFIED_PHONE_AVAILABLE);
  assert.equal(outcome.selected, null);
  assert.equal(outcome.reason, 'every-verified-candidate-lacked-a-valid-phone');
  assert.equal(outcome.diagnostics.malformedPhones, 1);
  assert.equal(outcome.diagnostics.noPhone, 1);
});

test('employer mismatch blocks selection and there is no fallback to another company', () => {
  const outcome = policy.selectPhoneFirst({
    mode: policy.MODES.PHONE_FIRST_INDIA,
    requiresPhone: true,
    company: ACME,
    budget: fullBudget(),
    candidates: [
      person({ apolloPersonId: 'other-co', name: 'Other Person', title: 'Director', phone: '+919876543210', country: 'India', organizationName: 'Globex Labs', organizationDomain: 'globex.example' }),
    ],
  });
  assert.equal(outcome.status, policy.OUTCOMES.NO_VERIFIED_PHONE_AVAILABLE);
  assert.equal(outcome.selected, null);
  assert.equal(outcome.reason, 'no-employer-verified-candidate');
  assert.equal(outcome.diagnostics.employerRejected, 1);
  assert.equal(outcome.diagnostics.indianQualified, 0);
});

test('a pending phone reveal is reported distinctly and never counted as a number', () => {
  const outcome = policy.selectPhoneFirst({
    mode: policy.MODES.PHONE_FIRST_INDIA,
    requiresPhone: true,
    company: ACME,
    budget: policy.createIndiaSearchBudget({ companyKey: 'acme' }),
    candidates: [
      person({
        apolloPersonId: 'pending-owner',
        name: 'Pending Owner',
        title: 'Talent Acquisition Lead',
        phoneStatus: 'pending',
        phoneRequestId: 'req-123',
      }),
    ],
  });
  assert.equal(outcome.status, policy.OUTCOMES.PHONE_REVEAL_PENDING);
  assert.equal(outcome.selected, null);
  assert.equal(outcome.diagnostics.pendingReveals, 1);
  assert.equal(policy.hasVerifiedPhone(person({ phoneStatus: 'pending' })), false);
  assert.equal(phoneOrPendingIsNotAWin(), true);
});

function phoneOrPendingIsNotAWin() {
  // A pending reveal has no phone evidence at all until Apollo settles it.
  return policy.phoneEvidence(person({ phoneStatus: 'pending' })).state === 'none';
}

test('people repeated across attempts are deduplicated by stable identity', () => {
  const duplicate = person({
    apolloPersonId: 'dup-1',
    name: 'Same Person',
    title: 'Recruiter',
    phone: '+919876543210',
    country: 'India',
    linkedinUrl: 'https://www.linkedin.com/in/same-person',
    email: 'same.person@acme.example',
  });
  const copy = { ...duplicate, phone: '+91 98765 43210' };
  const deduped = policy.dedupeCandidates([duplicate, copy, person({ apolloPersonId: 'other', name: 'Other' })]);
  assert.equal(deduped.people.length, 2);
  assert.equal(deduped.duplicates.length, 1);

  // Cross-strategy dedupe keeps one owner, so a person is never purchased twice.
  const sameByLinkedin = { ...person({ apolloPersonId: 'different-id', name: 'Same Person' }), linkedinUrl: 'https://www.linkedin.com/in/same-person' };
  assert.equal(policy.dedupeCandidates([duplicate, sameByLinkedin]).people.length, 1);
});

// --- 6. operator wiring ------------------------------------------------------

test('the operator exposes one explicit mode and gates the foreign tier on it', () => {
  const options = {};
  const state = operator.phoneFirstPolicyState({ requireIndianPhone: true, indianPhonePolicySource: 'explicit' }, options);
  assert.equal(state.mode, policy.MODES.PHONE_FIRST_INDIA);
  assert.equal(operator.indiaPhoneFirstEnabled(options), true);

  const before = operator.internationalFallbackGate(options, 'acme systems');
  assert.equal(before.allowed, false);
  for (const strategy of policy.INDIA_SEARCH_STRATEGIES) before.budget.record({ strategy });

  const after = operator.internationalFallbackGate(options, 'acme systems');
  assert.equal(after.allowed, true);
  assert.equal(after.reason, 'india-budget-exhausted');
  assert.equal(after.budget.attemptCount(), 5);

  // A hiring-authority run is never gated.
  const plain = {};
  operator.phoneFirstPolicyState({}, plain);
  assert.equal(operator.internationalFallbackGate(plain, 'acme systems').allowed, true);
  assert.equal(operator.indiaPhoneFirstEnabled(plain), false);
});

test('the operator reports typed phone outcomes instead of a generic failure', () => {
  const blocked = policy.exhaustedOutcome({
    mode: policy.MODES.PHONE_FIRST_INDIA,
    requiresPhone: true,
    budget: policy.createIndiaSearchBudget({ companyKey: 'acme' }),
  });
  assert.equal(blocked.status, policy.OUTCOMES.INDIA_SEARCH_INCOMPLETE);

  const definitive = policy.exhaustedOutcome({ mode: policy.MODES.PHONE_FIRST_INDIA, requiresPhone: true, budget: fullBudget() });
  assert.equal(definitive.status, policy.OUTCOMES.NO_VERIFIED_PHONE_AVAILABLE);

  const authority = policy.exhaustedOutcome({ mode: policy.MODES.HIRING_AUTHORITY, requiresPhone: false, budget: null });
  assert.equal(authority.status, 'NO_QUALIFIED_CONTACT');

  // The existing no-phone selection path still refuses without a phone.
  assert.equal(operator.chooseContactabilityCandidate([{ person: person({}), index: 0 }]), null);
  // And the gated foreign tier is respected by the live selection helper.
  const gated = operator.chooseContactabilityCandidate(
    [{ person: person({ phone: '+14155552671', country: 'United States', title: 'Founder' }), index: 0 }],
    { internationalFallbackAllowed: false },
  );
  assert.equal(gated, null);
  const ungated = operator.chooseContactabilityCandidate(
    [{ person: person({ phone: '+14155552671', country: 'United States', title: 'Founder' }), index: 0 }],
    { internationalFallbackAllowed: true },
  );
  assert.ok(ungated && ungated.tier >= 1);
});

// --- 7. latency + diagnostics ------------------------------------------------

test('latency percentiles and phone masking are safe for diagnostics', () => {
  const recorder = policy.createLatencyRecorder();
  for (const value of [10, 20, 30, 40, 100]) recorder.record('india-discovery', value);
  recorder.record('phone-reveal', 500);
  const summary = recorder.summary();
  assert.equal(summary['india-discovery'].samples, 5);
  assert.equal(summary['india-discovery'].p50, 30);
  assert.equal(summary['india-discovery'].p95, 100);
  assert.equal(summary['phone-reveal'].p50, 500);
  assert.equal(policy.percentile([], 0.5), null);
  assert.equal(policy.percentile([42], 0.95), 42);
  assert.equal(policy.maskPhone('+919876543210'), '+91******3210');
  assert.ok(!policy.maskPhone('+919876543210').includes('9876543210'.slice(0, 6)));
  assert.equal(policy.maskPhone(''), '');
});

test('the run-state summary distinguishes every terminal diagnostic, with no PII leak', () => {
  const state = policy.createRunState(policy.MODES.PHONE_FIRST_INDIA, { requiresPhone: true, source: 'test' });
  const budget = state.budgetFor('acme systems');
  for (const strategy of policy.INDIA_SEARCH_STRATEGIES) budget.record({ strategy });
  state.recordCounter('indianNumbersFound', 2);
  state.recordCounter('internationalFallbacksUsed', 1);
  state.recordCounter('noVerifiedPhoneRows', 3);
  state.recordCounter('pendingRevealsStaged', 1);
  state.latencies.record('india-discovery', 25);

  const summary = policy.summarize(state);
  assert.equal(summary.mode, policy.MODES.PHONE_FIRST_INDIA);
  assert.equal(summary.indiaBudgets.length, 1);
  assert.equal(summary.indiaBudgets[0].attemptsUsed, 5);
  assert.equal(summary.indiaBudgets[0].exhausted, true);
  assert.equal(summary.counters.noVerifiedPhoneRows, 3);
  assert.equal(summary.latency['india-discovery'].p50, 25);

  const indexed = policy.OUTCOMES;
  for (const status of ['INDIAN_PHONE_SELECTED', 'INTERNATIONAL_FALLBACK_SELECTED', 'NO_VERIFIED_PHONE_AVAILABLE', 'INDIA_SEARCH_INCOMPLETE', 'PHONE_REVEAL_PENDING']) {
    assert.equal(typeof indexed[status], 'string', `${status} must be a typed outcome`);
  }
  assert.ok(!JSON.stringify(summary).includes('+91'), 'diagnostics must not expose full phone values');
  assert.match(policy.humanSummary(state), /India search attempts used: 5 of 5/);
  assert.match(policy.humanSummary(state), /rows without a valid phone: 3/);
});

// --- 8. live route integration -----------------------------------------------

testAsync('the live deep-discovery path runs the five-attempt India plan (mocked provider)', async () => {
  const apollo = require('../core/apollo-enrichment');
  const original = apollo.searchCompanyPeopleBroad;
  const queries = [];
  apollo.searchCompanyPeopleBroad = async (options = {}) => {
    queries.push({
      titles: Array.isArray(options.titles) ? options.titles.length : 0,
      location: options.location || '',
      company: options.company || '',
    });
    return {
      people: [person({
        apolloPersonId: `live-${queries.length}`,
        name: `Live Person ${queries.length}`,
        title: 'HR Manager',
      })],
    };
  };

  try {
    const options = {
      requireIndianPhone: true,
      linkedinZeroResultFallback: false,
      publicIndexFallback: false,
    };
    const state = operator.phoneFirstPolicyState({ requireIndianPhone: true }, options);
    assert.equal(state.mode, policy.MODES.PHONE_FIRST_INDIA);

    const stats = operator.freshStats();
    const people = await operator.discoverPriorityPeopleFast(
      { company: 'Acme Systems', domain: 'acme.example' },
      new Map(),
      stats,
      options,
    );

    // Five distinct India-focused attempts, all individually recorded.
    assert.equal(stats.indiaSearchAttempts, 5);
    assert.equal(stats.indiaSearchAttemptsRemaining, 0);
    assert.equal(stats.indiaSearchExhausted, true);
    assert.equal(stats.indiaSearchStoppedEarly, null);
    assert.equal(stats.indiaSearchAttemptAudit.length, 5);
    assert.equal(new Set(stats.indiaSearchStrategyIds).size, 5);
    assert.ok(stats.candidateSearches >= 5);
    assert.ok(queries.filter((query) => query.location === 'India').length >= 5, 'every India attempt must be location-scoped');
    assert.ok(people.length >= 1, 'discovered people must reach the run pool');

    // With the budget complete, the international fallback is now unlocked for
    // this company, and only for this company.
    assert.equal(operator.internationalFallbackGate(options, 'acme systems').allowed, true);
    assert.equal(operator.internationalFallbackGate(options, 'other co').allowed, false);
  } finally {
    apollo.searchCompanyPeopleBroad = original;
  }
});

// ---------------------------------------------------------------------------
// TEST 23 — Discovery evidence is keyed by policy identity.
// ---------------------------------------------------------------------------
test('the discovery cache key is policy-versioned and isolated per mode', () => {
  assert.equal(typeof policy.POLICY_VERSION, 'string');
  assert.ok(policy.POLICY_VERSION.length > 0);

  const india = policy.cacheNamespace('priority-candidate-discovery', policy.MODES.PHONE_FIRST_INDIA);
  const authority = policy.cacheNamespace('priority-candidate-discovery', policy.MODES.HIRING_AUTHORITY);

  // Deterministic and cheap to recompute.
  assert.equal(india, policy.cacheNamespace('priority-candidate-discovery', policy.MODES.PHONE_FIRST_INDIA));
  // A pool gathered under one selection policy is never served to the other.
  assert.notEqual(india, authority);
  // The version stamp is part of the key, so a rule change invalidates it.
  assert.ok(india.includes(policy.POLICY_VERSION), 'the key must carry the policy version');
  assert.ok(authority.includes(policy.POLICY_VERSION));
  assert.match(india, /^priority-candidate-discovery@[^:]+:[^:]+:[0-9a-f]{8}$/);
  assert.match(authority, /^priority-candidate-discovery@[^:]+:[^:]+:[0-9a-f]{8}$/);
  assert.ok(india.includes(policy.MODES.PHONE_FIRST_INDIA));
  assert.ok(authority.includes(policy.MODES.HIRING_AUTHORITY));

  // Fingerprints are stable, mode-aware and rule-derived.
  assert.equal(policy.policyFingerprint(policy.MODES.PHONE_FIRST_INDIA), policy.policyFingerprint({ mode: 'phone-first-india' }));
  assert.notEqual(policy.policyFingerprint(policy.MODES.PHONE_FIRST_INDIA), policy.policyFingerprint(policy.MODES.HIRING_AUTHORITY));
  // An unknown or absent mode can never widen the key space.
  assert.equal(policy.policyFingerprint(''), policy.policyFingerprint(policy.MODES.HIRING_AUTHORITY));
});

// ---------------------------------------------------------------------------
// TEST 24 — Resume refuses a mission whose saved policy no longer matches.
// ---------------------------------------------------------------------------
test('resume refuses a mission whose saved policy differs from the run', () => {
  const savedPhoneFirst = {
    policyMode: 'phone-first-india',
    policySource: 'automatic-poc1-poc2-default',
    policyIndiaRequired: true,
  };

  // Same policy resumes cleanly.
  const same = policy.policyConflict(savedPhoneFirst, policy.resolveMode({ policyMode: 'phone-first-india' }, {}));
  assert.equal(same.conflict, false);
  assert.equal(same.reason, 'policy-match');

  // A mission approved as phone-first must never silently resume as
  // hiring-authority, where a phone is not a hard qualification.
  const drift = policy.policyConflict(savedPhoneFirst, policy.resolveMode({}, {}));
  assert.equal(drift.conflict, true);
  assert.equal(drift.code, 'UNIVERSAL_RESUME_POLICY_CHANGED');
  assert.equal(drift.savedMode, 'phone-first-india');
  assert.equal(drift.currentMode, 'hiring-authority');
  assert.equal(drift.savedIndiaRequired, true);
  assert.equal(drift.currentIndiaRequired, false);

  // And the reverse direction is equally refused.
  const reverse = policy.policyConflict(
    { policyMode: 'hiring-authority' },
    policy.resolveMode({ originalMessage: 'Enrich with Indian phone numbers for POC-1 and POC-2.' }, {}),
  );
  assert.equal(reverse.conflict, true);
  assert.equal(reverse.savedMode, 'hiring-authority');
  assert.equal(reverse.currentMode, 'phone-first-india');

  assert.throws(
    () => policy.assertPolicyContinuity(savedPhoneFirst, policy.resolveMode({}, {})),
    (error) => error.code === 'UNIVERSAL_RESUME_POLICY_CHANGED',
  );
  try {
    policy.assertPolicyContinuity(savedPhoneFirst, policy.resolveMode({}, {}));
    assert.fail('assertPolicyContinuity must throw on a policy change');
  } catch (error) {
    assert.equal(error.subsystem, 'POLICY');
    assert.equal(error.errorType, 'POLICY');
    assert.ok(Array.isArray(error.questions) && error.questions.length > 0);
    assert.equal(error.diagnostics.code, 'UNIVERSAL_RESUME_POLICY_CHANGED');
  }

  // A legacy mission that predates the policy record never blocks a resume.
  const legacy = policy.policyConflict({}, policy.resolveMode({ policyMode: 'phone-first-india' }, {}));
  assert.equal(legacy.conflict, false);
  assert.equal(legacy.reason, 'legacy-mission-without-policy');
});

// ---------------------------------------------------------------------------
// TEST 25 — Real per-stage timings are recorded with p50/p95, not just totals.
// ---------------------------------------------------------------------------
test('the pipeline records actual per-stage p50/p95 latencies', async () => {
  const original = apolloModule.searchCompanyPeopleBroad;
  try {
    apolloModule.searchCompanyPeopleBroad = async () => ({
      people: [
        { id: 'india-1', name: 'Anita Rao', title: 'Recruiter', organization: { name: 'Acme Systems' }, location: 'Pune, India', phone: '+91 98765 43210' },
      ],
    });
    const options = { requireIndianPhone: true, linkedinZeroResultFallback: false, publicIndexFallback: false };
    const stats = operator.freshStats();
    await operator.discoverPriorityPeopleFast(
      { company: 'Acme Systems', domain: 'acme.example' },
      new Map(),
      stats,
      options,
    );

    const summary = options.phoneFirstPolicyState.latencies.summary();
    assert.ok(summary['discovery-priority'], 'the discovery stage must be measured');
    const stage = summary['discovery-priority'];
    assert.ok(stage.samples >= 1, 'a measured stage must have at least one sample');
    assert.ok(Number.isFinite(stage.p50) && stage.p50 >= 0);
    assert.ok(Number.isFinite(stage.p95) && stage.p95 >= stage.p50);
    assert.ok(Number.isFinite(stage.max) && stage.max >= stage.p95);
    // Timings are plain numbers: never a phone value or any other PII.
    assert.equal(typeof stage.p50, 'number');
  } finally {
    apolloModule.searchCompanyPeopleBroad = original;
  }
});

// ---------------------------------------------------------------------------
// TEST 26 — A transient discovery failure is never cached as "no people".
// ---------------------------------------------------------------------------
test('a transient discovery failure is never cached as a negative result', async () => {
  const original = apolloModule.searchCompanyPeopleBroad;
  const companyContext = { company: 'Transient Systems', domain: 'transient.example' };
  const localCache = new Map();
  const stats = operator.freshStats();
  const options = { linkedinZeroResultFallback: false, publicIndexFallback: false };
  const key = `${ranker.companyKey(companyContext.company)}|${ranker.hostname(companyContext.domain)}|`;
  const namespace = policy.cacheNamespace('candidate-discovery', policy.MODES.HIRING_AUTHORITY);

  try {
    // Broad search answers honestly with nothing; the supplemental targeted
    // search then fails with a NON-systemic provider error, so the run keeps
    // going with incomplete evidence.
    apolloModule.searchCompanyPeopleBroad = async (query = {}) => {
      if (Array.isArray(query.titles) && query.titles.length) {
        throw Object.assign(new Error('Apollo returned no matching person'), { code: 'APOLLO_PERSON_NOT_FOUND' });
      }
      return { people: [] };
    };

    const incomplete = await operator.discoverCompanyPeople(companyContext, localCache, stats, options);
    assert.equal(incomplete.length, 0);
    assert.ok(stats.candidatePrioritySearchFailures >= 1, 'the failure must be recorded, not swallowed');
    assert.equal(
      durableCache.get(namespace, key).hit,
      false,
      'an incomplete search must not be remembered as evidence that the company has no people',
    );
  } finally {
    apolloModule.searchCompanyPeopleBroad = original;
  }

  // Control: a clean, complete empty result IS still cached, so genuinely empty
  // companies are not re-queried on every row.
  const cleanStats = operator.freshStats();
  const cleanOptions = { linkedinZeroResultFallback: false, publicIndexFallback: false };
  try {
    apolloModule.searchCompanyPeopleBroad = async () => ({ people: [] });
    await operator.discoverCompanyPeople(companyContext, new Map(), cleanStats, cleanOptions);
    const hit = durableCache.get(policy.cacheNamespace('candidate-discovery', policy.MODES.HIRING_AUTHORITY), key);
    assert.equal(hit.hit, true, 'a complete empty result must still be cached as a negative');
    assert.equal(hit.negative, true);
  } finally {
    apolloModule.searchCompanyPeopleBroad = original;
  }
});

runSuite();
