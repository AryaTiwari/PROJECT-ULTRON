'use strict';

const assert = require('assert/strict');
const hardening = require('../core/apollo-fetch-hardening');
const apollo = require('../core/apollo-enrichment');

assert.equal(hardening.isApolloUrl('https://api.apollo.io/api/v1/mixed_people/api_search'), true);
assert.equal(hardening.isApolloUrl('https://sheets.googleapis.com/v4/spreadsheets/abc'), false);
assert.equal(hardening.isTransportFailure(new TypeError('Failed to fetch')), true);
assert.equal(hardening.isTransportFailure(new Error('Apollo returned HTTP 400')), false);
const bodyError = apollo.apolloBodyReadError(new TypeError('terminated'), 3, 'https://api.apollo.io/api/v1/people/match');
assert.equal(bodyError.code, 'APOLLO_NETWORK_BODY_READ_FAILED');
assert.equal(bodyError.subsystem, 'APOLLO');
assert.equal(bodyError.errorType, 'NETWORK');
assert.equal(bodyError.retryAttempts, 3);

async function run() {
  const originalGlobalFetch = globalThis.fetch;
  try {

  let directAttempts = 0;
  globalThis.fetch = async () => {
    directAttempts++;
    if (directAttempts < 3) throw new TypeError('Failed to fetch');
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '{"ok":true}',
    };
  };
  const directRecovered = await apollo.fetchApolloResponse(
    'https://api.apollo.io/api/v1/people/match',
    { method: 'POST' },
    { retries: 2 },
  );
  assert.equal(directRecovered.response.ok, true);
  assert.equal(directAttempts, 3, 'Apollo HTTP helper itself must retry thrown fetch transport failures');

  let directFailedAttempts = 0;
  globalThis.fetch = async () => {
    directFailedAttempts++;
    const error = new TypeError('Failed to fetch');
    error.cause = Object.assign(new Error('getaddrinfo EAI_AGAIN api.apollo.io'), { code: 'EAI_AGAIN' });
    throw error;
  };
  await assert.rejects(
    () => apollo.fetchApolloResponse(
      'https://api.apollo.io/api/v1/people/match',
      { method: 'POST' },
      { retries: 2 },
    ),
    (error) => {
      assert.equal(error.code, 'APOLLO_NETWORK_FETCH_FAILED');
      assert.equal(error.subsystem, 'APOLLO');
      assert.equal(error.errorType, 'NETWORK');
      assert.equal(error.stage, 'apollo-http-transport');
      assert.equal(error.retryAttempts, 3);
      return true;
    },
  );
  assert.equal(directFailedAttempts, 3);

  let preTypedAttempts = 0;
  globalThis.fetch = async () => {
    preTypedAttempts++;
    throw hardening.typedNetworkError(new TypeError('Failed to fetch'), 3, 'https://api.apollo.io/api/v1/people/match');
  };
  await assert.rejects(
    () => apollo.fetchApolloResponse(
      'https://api.apollo.io/api/v1/people/match',
      { method: 'POST' },
      { retries: 2 },
    ),
    (error) => error?.code === 'APOLLO_NETWORK_FETCH_FAILED' && error?.retryAttempts === 3,
  );
  assert.equal(preTypedAttempts, 1, 'already-typed global hardener failure must not be retried again by the Apollo helper');

  globalThis.fetch = originalGlobalFetch;

  let attempts = 0;
  const recovers = hardening.createHardenedFetch(async () => {
    attempts++;
    if (attempts < 3) throw new TypeError('Failed to fetch');
    return { ok: true, status: 200 };
  }, { retries: 2, baseDelayMs: 0 });

  const response = await recovers('https://api.apollo.io/api/v1/people/match', { method: 'POST', body: '{}' });
  assert.equal(response.ok, true);
  assert.equal(attempts, 3, 'Apollo transport wrapper must retry a transient fetch exception twice before succeeding');

  let failedAttempts = 0;
  const alwaysFails = hardening.createHardenedFetch(async () => {
    failedAttempts++;
    const error = new TypeError('fetch failed');
    error.cause = Object.assign(new Error('getaddrinfo EAI_AGAIN api.apollo.io'), { code: 'EAI_AGAIN' });
    throw error;
  }, { retries: 2, baseDelayMs: 0 });

  await assert.rejects(
    () => alwaysFails('https://api.apollo.io/api/v1/mixed_people/api_search', { method: 'POST', body: '{}' }),
    (error) => {
      assert.equal(error.code, 'APOLLO_NETWORK_FETCH_FAILED');
      assert.equal(error.subsystem, 'APOLLO');
      assert.equal(error.errorType, 'NETWORK');
      assert.equal(error.retryAttempts, 3);
      return true;
    },
  );
  assert.equal(failedAttempts, 3);

  let googleAttempts = 0;
  const passThrough = hardening.createHardenedFetch(async () => {
    googleAttempts++;
    throw new TypeError('Failed to fetch');
  }, { retries: 2, baseDelayMs: 0 });
  await assert.rejects(() => passThrough('https://sheets.googleapis.com/v4/spreadsheets/x'), /Failed to fetch/);
  assert.equal(googleAttempts, 1, 'non-Apollo requests must not be intercepted by Apollo hardening');

    console.log('Apollo fetch hardening self-test passed: the Apollo HTTP helper and global hardener both retry thrown transport failures, exhausted network failures are typed, interrupted response bodies are typed, and non-Apollo fetches stay untouched.');
  } finally {
    globalThis.fetch = originalGlobalFetch;
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { run };
