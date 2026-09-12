#!/usr/bin/env node
const assert = require('assert');
const router = require('../core/linkedin-command-router');

assert.equal(router.requestedContactEnrichment('Find 20 SAP companies on LinkedIn in Maharashtra'), false);
assert.equal(router.requestedContactEnrichment('Find 20 SAP companies on LinkedIn and get HR contact emails'), true);

const globalText = 'Find me 25 companies on LinkedIn hiring Java developer roles in Austin, Texas, remote, under 500 employees';
assert.equal(router.genericLocationFromText(globalText, ''), 'Austin, Texas');
const enhancedGlobal = router.enhanceRequest({
  criteriaText: globalText,
  entityMode: 'company',
  hiring: true,
  location: '',
  locationScope: 'job',
  topic: 'Java developer Austin Texas',
  filters: { workType: 'remote', employeeMax: 500 },
  destinationSheetUrl: null,
}, globalText, 'https://docs.google.com/spreadsheets/d/master123/edit');
assert.equal(enhancedGlobal.location, 'Austin, Texas');
assert.equal(enhancedGlobal.topic, 'Java developer');
assert.equal(enhancedGlobal.wantsContacts, false);

const londonText = 'Find remote cybersecurity analyst jobs on LinkedIn in London, United Kingdom';
assert.equal(router.genericLocationFromText(londonText, ''), 'London, United Kingdom');

const masterText = 'Find 15 remote Python roles on LinkedIn in Berlin and add them to the master sheet';
const enhancedMaster = router.enhanceRequest({
  criteriaText: masterText,
  entityMode: 'company',
  hiring: true,
  location: '',
  topic: 'Python Berlin',
  filters: { workType: 'remote' },
  destinationSheetUrl: null,
}, masterText, 'https://docs.google.com/spreadsheets/d/master123/edit');
assert.equal(enhancedMaster.location, 'Berlin');
assert.equal(enhancedMaster.topic, 'Python');
assert.equal(enhancedMaster.destinationSheetUrl, 'https://docs.google.com/spreadsheets/d/master123/edit');

assert.equal(router.wantsMasterSheet('put them in the consolidated spreadsheet'), true);
assert.equal(router.wantsMasterSheet('create a new sheet'), false);

assert.deepEqual(
  router.parseSheetEdit('add columns WEBSITE, NOTES and PRIORITY to the current sheet'),
  { operation: 'add', columns: ['WEBSITE', 'NOTES', 'PRIORITY'] }
);
assert.deepEqual(
  router.parseSheetEdit('rename column REMARKS to NEXT ACTION in the current sheet'),
  { operation: 'rename', from: 'REMARKS', to: 'NEXT ACTION' }
);
assert.deepEqual(
  router.parseSheetEdit('remove columns PHONE NUMBER and EMAIL from the master sheet'),
  { operation: 'delete', columns: ['PHONE NUMBER', 'EMAIL'] }
);
assert.equal(
  router.isSheetEditRequest('add column WEBSITE to the current sheet', 'https://docs.google.com/spreadsheets/d/master123/edit'),
  true
);
assert.equal(router.isSheetEditRequest('tell me about spreadsheets', null), false);

assert.equal(
  router.isSetWorkspaceRequest('Use https://docs.google.com/spreadsheets/d/master123/edit as my current LinkedIn sheet'),
  true
);

console.log('LinkedIn command router self-test passed: global locations, generic role cleanup, explicit contact intent, master-sheet routing and safe column edits are healthy.');
