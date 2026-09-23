const assert = require('node:assert/strict');
const control = require('../core/command-control-plane');
const operator = require('../core/linkedin-account-operator');
const schema = require('../core/linkedin-sheet-schema-resolver');

assert.equal(operator.headerKey('Company Name'), 'company');
assert.equal(operator.headerKey('Vacancy URL', { 'vacancy url': 'jobLink' }), 'jobLink');
assert.equal(operator.headerKey('Owner Notes', { 'owner notes': 'ignore' }), 'ignore');

const noContactUnknowns = schema.unresolvedHeaders(
  ['COMPANY NAME', 'COMPANY LINK', 'JOB LINK', 'POC Name', 'Phone Number', 'Email ID', 'Owner Notes'],
  operator.headerKey,
);
assert.deepEqual(noContactUnknowns, []);

const user = schema.userMappings(
  'map: "Vacancy URL" = job link; "Priority" = lead score; "Owner Notes" = ignore',
  ['Vacancy URL', 'Priority', 'Owner Notes'],
  operator.headerKey,
);
assert.deepEqual(user, {
  'vacancy url': 'jobLink',
  priority: 'score',
  'owner notes': 'ignore',
});

const exclusive = schema.exclusiveUserMappings(
  'only add company name, company link and job link',
  ['Company Name', 'Company Link', 'Job Link', 'Outcome', 'Employees', 'Location'],
  operator.headerKey,
);
assert.deepEqual(exclusive, {
  'company name': 'company',
  'company link': 'linkedin',
  'job link': 'jobLink',
  outcome: 'ignore',
  employees: 'ignore',
  location: 'ignore',
});
assert.deepEqual(operator.rowFor(
  { company: 'Acme', linkedin: 'https://linkedin.com/company/acme', jobUrl: 'https://linkedin.com/jobs/view/1', employeeCount: { label: '51-200' }, location: 'India' },
  ['Company Name', 'Company Link', 'Job Link', 'Outcome', 'Employees', 'Location'],
  { wantsContacts: false, headerMappings: exclusive },
), ['Acme', 'https://linkedin.com/company/acme', 'https://linkedin.com/jobs/view/1', '', '', '']);

const accepted = schema.acceptedMappings({ mappings: [
  { header: 'Vacancy URL', key: 'jobLink', confidence: 0.97 },
  { header: 'Mystery', key: 'industry', confidence: 0.5 },
]}, ['Vacancy URL', 'Mystery']);
assert.deepEqual(accepted.mappings, { 'vacancy url': 'jobLink' });
assert.deepEqual(accepted.unresolved, ['Mystery']);

(async () => {
  const inferred = await schema.resolve(
    ['COMPANY NAME', 'Vacancy URL', 'Priority'],
    { wantsContacts: false },
    operator.headerKey,
    {
      models: ['groq/test-schema-model'],
      chat: async () => ({
        content: JSON.stringify({ mappings: [
          { header: 'Vacancy URL', key: 'jobLink', confidence: 0.99 },
          { header: 'Priority', key: 'score', confidence: 0.94 },
        ] }),
        model: 'test-schema-model',
        provider: 'groq',
      }),
    },
  );
  assert.deepEqual(inferred.unresolved, []);
  assert.equal(inferred.mappings['vacancy url'], 'jobLink');
  assert.equal(inferred.mappings.priority, 'score');

  assert.doesNotThrow(() => control.runInternalInference('linkedin', () => {
    control.assertAllowed('direct-model', { model: 'groq/test', messages: [{ role: 'user', content: '{}' }] });
  }));
  await assert.rejects(
    () => control.runExclusive(() => control.assertAllowed('direct-model', { model: 'groq/test', messages: [{ role: 'user', content: '{}' }] })),
    /exclusive route forbids direct-model/,
  );

  const record = {
    company: 'Acme India',
    linkedin: 'https://www.linkedin.com/company/acme/',
    jobUrl: 'https://www.linkedin.com/jobs/view/123/',
    location: 'Mumbai',
    industry: 'Technology',
    email: 'should-not-write@example.com',
    phone: '+919999999999',
    remarks: 'contact remark',
  };
  const row = operator.rowFor(
    record,
    ['Company Name', 'Company Link', 'Vacancy URL', 'Location', 'Email', 'Phone', 'Remarks', 'Sector Label'],
    { wantsContacts: false, headerMappings: { 'vacancy url': 'jobLink', 'sector label': 'industry' } },
  );
  assert.deepEqual(row, [
    'Acme India',
    'https://www.linkedin.com/company/acme/',
    'https://www.linkedin.com/jobs/view/123/',
    'Mumbai',
    '',
    '',
    '',
    'Technology',
  ]);

  const contactRow = operator.rowFor(record, ['Email', 'Phone', 'Remarks'], { wantsContacts: true });
  assert.deepEqual(contactRow, ['should-not-write@example.com', '+919999999999', 'contact remark']);

  assert.match(schema.clarificationText(['Custom Metric']), /before starting LinkedIn research/i);
  assert.match(schema.clarificationText(['Custom Metric']), /POC, phone and email columns will remain blank/i);
  console.log('LinkedIn Sheet schema self-test passed: existing headings drive writes, unknown headings use bounded env-backed inference, ambiguous headings request a mapping before discovery, and contact fields stay blank unless enrichment is explicit.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
