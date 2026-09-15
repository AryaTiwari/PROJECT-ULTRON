const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-apollo-test-'));
const configPath = require.resolve('../core/config');
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: { projectRoot: root, mark3Root: root },
};

process.env.APOLLO_API_KEY = 'mock-only';
process.env.APOLLO_WEBHOOK_URL = 'https://example.invalid/callback';
process.env.APOLLO_WEBHOOK_SECRET = 'mock-only';

const apollo = require('../core/apollo-enrichment');

assert.equal(apollo.decisionPriority('Founder'), 1);
assert.equal(apollo.decisionPriority('Managing Director'), 1);
assert.equal(apollo.decisionPriority('Head Recruiter'), 2);
assert.equal(apollo.decisionPriority('Recruitment Manager'), 2);
assert.equal(apollo.decisionPriority('Manager'), 2);
assert.equal(apollo.decisionPriority('HR Recruiter'), 3);
assert.equal(apollo.decisionPriority('Account Manager'), 99);
assert.deepEqual(
  apollo.COMPANY_DECISION_PRIORITY.map((tier) => tier.priority),
  [1, 2, 3],
);

assert.equal(apollo.validEmail('test@example.com'), 'test@example.com');
assert.equal(apollo.validEmail('12'), null);
assert.equal(apollo.validPhone('+91 98765 43210'), '+91 98765 43210');
assert.equal(apollo.validPhone('12'), null);
assert.equal(apollo.validPhone('null'), null);

(async () => {
  let searchCalls = 0;
  global.fetch = async url => {
    assert.match(url.pathname, /mixed_people\/api_search$/);
    searchCalls++;
    const titles = url.searchParams.getAll('person_titles[]');

    if (searchCalls === 1) {
      assert(titles.includes('founder'));
      assert(titles.includes('director'));
      assert.equal(titles.includes('HR recruiter'), false);
      return {
        ok: true,
        text: async () => JSON.stringify({ people: [] }),
      };
    }

    if (searchCalls === 2) {
      assert(titles.includes('head recruiter'));
      assert(titles.includes('recruitment manager'));
      assert.equal(titles.includes('HR recruiter'), false);
      return {
        ok: true,
        text: async () => JSON.stringify({
          people: [{
            id: 'manager-1',
            name: 'Hiring Manager',
            title: 'Recruitment Manager',
            linkedin_url: 'https://www.linkedin.com/in/hiring-manager',
            organization: { name: 'Acme', primary_domain: 'acme.test' },
          }],
        }),
      };
    }

    throw new Error('Apollo should stop after the first matching priority tier.');
  };

  const selected = await apollo.searchCompanyDecisionMaker({
    company: 'Acme',
    domain: 'acme.test',
    priorityMode: 'hiring',
  });
  assert.equal(searchCalls, 2);
  assert.equal(selected.candidate.id, 'manager-1');
  assert.equal(selected.candidate.decisionPriority, 2);
  assert.equal(selected.selectedPriority, 2);
  assert.match(selected.selectedPriorityLabel, /Head Recruiter \/ Manager/);

  let identityCalls = 0;
  global.fetch = async url => {
    identityCalls++;
    assert.equal(url.searchParams.get('id'), 'person-1');
    assert.equal(url.searchParams.has('linkedin_url'), false);
    return {
      ok: true,
      text: async () => JSON.stringify({
        person: {
          id: 'person-1',
          name: 'Test Person',
          title: 'Director',
          linkedin_url: 'https://www.linkedin.com/in/test-person',
          email: 'test@example.com',
          organization: { name: 'Acme', primary_domain: 'acme.test' },
        },
      }),
    };
  };

  const candidate = {
    id: 'person-1',
    title: 'Director',
    decisionPriority: 1,
    organization: { name: 'Acme' },
  };
  const resolved = await apollo.resolveDecisionMaker(candidate, 'Acme', 'acme.test');
  assert.equal(resolved.name, 'Test Person');
  assert.equal(resolved.decisionPriority, 1);

  await apollo.resolveDecisionMaker(candidate, 'Acme', 'acme.test');
  const enriched = await apollo.enrich(resolved.linkedinUrl, { needEmail: true, needPhone: true });
  assert.equal(enriched.cached, true);
  assert.equal(enriched.email, 'test@example.com');
  assert.equal(identityCalls, 1);

  console.log('Apollo identity tests passed: strict company tier order, manager fallback, verified company identity, and exact-person phone/email cache reuse.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
