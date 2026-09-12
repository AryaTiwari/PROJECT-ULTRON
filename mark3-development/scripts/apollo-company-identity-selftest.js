const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-apollo-test-'));
const configPath = require.resolve('../core/config');
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: { projectRoot: root, mark3Root: root } };
process.env.APOLLO_API_KEY = 'mock-only';
process.env.APOLLO_WEBHOOK_URL = 'https://example.invalid/callback';
process.env.APOLLO_WEBHOOK_SECRET = 'mock-only';
const apollo = require('../core/apollo-enrichment');
let calls = 0;
global.fetch = async url => {
  calls++;
  assert.equal(url.searchParams.get('id'), 'person-1');
  assert.equal(url.searchParams.has('linkedin_url'), false);
  return { ok: true, text: async () => JSON.stringify({ person: {
    id: 'person-1', name: 'Test Person', title: 'Director', linkedin_url: 'https://www.linkedin.com/in/test-person',
    email: 'test@example.com', organization: { name: 'Acme', primary_domain: 'acme.test' }
  } }) };
};
(async () => {
  const candidate = { id: 'person-1', title: 'Director', organization: { name: 'Acme' } };
  const resolved = await apollo.resolveDecisionMaker(candidate, 'Acme', 'acme.test');
  assert.equal(resolved.name, 'Test Person');
  await apollo.resolveDecisionMaker(candidate, 'Acme', 'acme.test');
  const enriched = await apollo.enrich(resolved.linkedinUrl, { needEmail: true, needPhone: true });
  assert.equal(enriched.cached, true);
  assert.equal(enriched.email, 'test@example.com');
  assert.equal(calls, 1);
  console.log('Apollo identity tests passed: ID lookup, verified company, complete name and cache reuse without duplicate enrichment calls.');
})().catch(error => { console.error(error); process.exitCode = 1; });
