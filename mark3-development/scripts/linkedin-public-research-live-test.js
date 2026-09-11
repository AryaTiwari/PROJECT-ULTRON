#!/usr/bin/env node
process.env.ULTRON_M3_LINKEDIN_MAX_SEARCH_CALLS = process.env.ULTRON_M3_LINKEDIN_MAX_SEARCH_CALLS || '2';

const assert = require('assert');
const linkedin = require('../core/linkedin-public-research');

async function main() {
  const status = linkedin.status();
  assert.equal(status.configured, true, 'SERP_API_KEY is not loaded.');

  const result = await linkedin.research(
    'companies on LinkedIn hiring SAP professionals in Maharashtra',
    1,
    { entityMode: 'company', location: 'Maharashtra', hiring: true }
  );

  assert.ok(result.searchCalls >= 1, 'LinkedIn public research made no search call.');
  assert.ok(result.searchCalls <= 2, 'LinkedIn live test exceeded its two-call cap.');
  assert.ok(Array.isArray(result.records), 'LinkedIn live test did not return a records array.');
  for (const record of result.records) {
    assert.equal(record.entityType, 'company');
    assert.ok(/^https:\/\/www\.linkedin\.com\/company\//i.test(record.linkedin || ''));
  }

  console.log('LinkedIn public research live test passed.');
  console.log(`Search calls: ${result.searchCalls}; company profiles found: ${result.found}; access mode: ${result.access}.`);
  if (!result.found) console.log('No matching public-indexed company profile appeared in this tiny test query; integration itself still responded correctly.');
}

main().catch((error) => {
  console.error('LinkedIn public research live test failed:', error.message);
  process.exitCode = 1;
});
