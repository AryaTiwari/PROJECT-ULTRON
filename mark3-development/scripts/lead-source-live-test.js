#!/usr/bin/env node
const assert = require('assert');
const source = require('../core/lead-source-fusion');

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${String(data?.error?.message || data?.error || raw).slice(0, 500)}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const state = source.status();
  console.log('Lead Source Fusion status:', {
    serpApiConfigured: state.serpApiConfigured,
    apifyConfigured: state.apifyConfigured,
    apifyActor: state.apifyActor,
    maxJobSignals: state.maxJobSignals,
    maxMapPlaces: state.maxMapPlaces,
  });

  assert.equal(state.serpApiConfigured, true, 'SERP_API_KEY is not loaded.');
  assert.equal(state.apifyConfigured, true, 'APIFY_API_KEY/APIFY_API_TOKEN is not loaded.');

  const me = await fetchJson('https://api.apify.com/v2/users/me', {
    headers: { Authorization: `Bearer ${source.apifyApiKey()}`, Accept: 'application/json' },
  });
  assert.ok(me?.data?.id || me?.data?.username, 'Apify token authenticated but account metadata was not returned.');
  console.log('Apify token: OK');

  const serp = await source.serpSearch('site:linkedin.com/in recruiter India', { limit: 1, timeoutMs: 15000 });
  assert.ok(serp.results?.length, 'SerpApi returned no organic test result.');
  console.log('SerpApi Google search: OK');

  if (/^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_LEAD_SOURCE_LIVE_JOBS || '0'))) {
    const jobs = await source.googleJobs('SAP consultant', { location: 'Bengaluru, India', limit: 3, timeoutMs: 20000 });
    console.log(`SerpApi Google Jobs: OK (${jobs.length} signals)`);
  } else {
    console.log('Google Jobs live call skipped. Set ULTRON_M3_LEAD_SOURCE_LIVE_JOBS=1 to test it.');
  }

  if (/^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_LEAD_SOURCE_LIVE_MAPS || '0'))) {
    const maps = await source.apifyGoogleMaps('marketing agencies', { location: 'Kolkata, India', limit: 1, timeoutMs: 120000 });
    console.log(`Apify Google Maps actor: OK (${maps.length} place result${maps.length === 1 ? '' : 's'})`);
  } else {
    console.log('Apify Maps actor run skipped to protect credits. Set ULTRON_M3_LEAD_SOURCE_LIVE_MAPS=1 to test one place.');
  }

  console.log('Lead Source Fusion live doctor passed.');
}

main().catch((error) => {
  console.error('Lead Source Fusion live doctor failed:', error.message);
  process.exitCode = 1;
});
