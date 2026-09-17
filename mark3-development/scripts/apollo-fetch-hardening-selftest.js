'use strict';

const assert = require('assert/strict');
const hardening = require('../core/apollo-fetch-hardening');

assert.equal(hardening.isApolloUrl('https://api.apollo.io/api/v1/mixed_people/api_search'), true);
assert.equal(hardening.isApolloUrl('https://sheets.googleapis.com/v4/spreadsheets/abc'), false);
assert.equal(hardening.isTransportFailure(new TypeError('Failed to fetch')), true);
assert.equal(hardening.isTransportFailure(new Error('Apollo returned HTTP 400')), false);

(async () => {
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

  console.log('Apollo fetch hardening self-test passed: Apollo transport failures retry twice then surface APOLLO_NETWORK_FETCH_FAILED; non-Apollo fetches stay untouched.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
