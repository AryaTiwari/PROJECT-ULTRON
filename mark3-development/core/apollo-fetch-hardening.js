'use strict';

// Apollo enrichment historically called global fetch directly. A transient
// Node/Undici DNS/TLS/socket failure therefore escaped as bare "Failed to fetch".
// Harden only Apollo/API-worker requests so unrelated providers keep their own
// transport policies.

const INSTALL_FLAG = Symbol.for('ultron.mark3.apolloFetchHardening.installed');

const state = {
  calls: 0,
  transportRetries: 0,
  recovered: 0,
  failures: 0,
  lastUrl: null,
  lastError: null,
};

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function configuredWebhookOrigin() {
  const raw = String(process.env.APOLLO_WEBHOOK_URL || '').trim();
  if (!raw) return '';
  try { return new URL(raw).origin; } catch { return ''; }
}

function urlText(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return String(input?.url || '');
}

function isApolloUrl(input) {
  const raw = urlText(input);
  if (!raw) return false;
  try {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() === 'api.apollo.io') return true;
    const workerOrigin = configuredWebhookOrigin();
    return Boolean(workerOrigin && url.origin === workerOrigin);
  } catch {
    return false;
  }
}

function transportMessage(error) {
  return [error?.message, error?.cause?.message, error?.cause?.code, error?.code]
    .filter(Boolean).join(' ');
}

function isTransportFailure(error) {
  const value = transportMessage(error);
  return /failed to fetch|fetch failed|econnrefused|econnreset|enotfound|eai_again|etimedout|socket|tls|network|dns/i.test(value);
}

function typedNetworkError(cause, attempts, url) {
  const message = String(cause?.message || cause || 'unknown transport failure');
  const error = new Error(`Apollo network request failed after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${message}`);
  error.code = 'APOLLO_NETWORK_FETCH_FAILED';
  error.subsystem = 'APOLLO';
  error.errorType = 'NETWORK';
  error.stage = 'apollo-http-transport';
  error.retryAttempts = attempts;
  error.endpoint = url;
  error.cause = cause;
  error.hint = 'Apollo could not be reached after automatic retry. Check internet, DNS, firewall/proxy and Apollo availability.';
  return error;
}

function createHardenedFetch(originalFetch, options = {}) {
  if (typeof originalFetch !== 'function') throw new TypeError('A fetch implementation is required.');
  const retries = Math.max(0, Math.min(5, Number(options.retries ?? 2)));
  const baseDelayMs = Math.max(0, Math.min(5000, Number(options.baseDelayMs ?? 250)));

  return async function apolloSafeFetch(input, init) {
    if (!isApolloUrl(input)) return originalFetch(input, init);
    const endpoint = urlText(input);
    state.calls++;
    state.lastUrl = endpoint;
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await originalFetch(input, init);
        if (attempt > 0) state.recovered++;
        return result;
      } catch (error) {
        lastError = error;
        state.lastError = String(error?.message || error || '').slice(0, 500);
        if (!isTransportFailure(error)) throw error;
        if (attempt >= retries) break;
        state.transportRetries++;
        await sleep(baseDelayMs * (2 ** attempt));
      }
    }

    state.failures++;
    throw typedNetworkError(lastError, retries + 1, endpoint);
  };
}

function snapshot() { return { ...state }; }

function reset() {
  state.calls = 0;
  state.transportRetries = 0;
  state.recovered = 0;
  state.failures = 0;
  state.lastUrl = null;
  state.lastError = null;
}

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];
  if (typeof globalThis.fetch !== 'function') {
    const error = new Error('Global fetch is unavailable; Apollo enrichment cannot make HTTP requests.');
    error.code = 'APOLLO_FETCH_UNAVAILABLE';
    error.subsystem = 'APOLLO';
    error.errorType = 'CONFIG';
    throw error;
  }
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = createHardenedFetch(originalFetch);
  const api = Object.freeze({ installed: true, isApolloUrl, isTransportFailure, createHardenedFetch, snapshot, reset });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

module.exports = {
  install,
  isApolloUrl,
  isTransportFailure,
  createHardenedFetch,
  typedNetworkError,
  snapshot,
  reset,
};
