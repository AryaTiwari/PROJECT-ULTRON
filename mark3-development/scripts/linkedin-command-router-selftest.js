#!/usr/bin/env node
const assert = require('assert');
const router = require('../core/linkedin-command-router');

const group = String(process.env.ULTRON_LINKEDIN_COMMAND_TEST_GROUP || 'all').trim().toLowerCase();
const run = (name) => group === 'all' || group === name;

if (run('intent')) {
  assert.equal(router.requestedContactEnrichment('Find 20 SAP companies on LinkedIn in Maharashtra'), false);
  assert.equal(router.requestedContactEnrichment('Find 20 SAP companies on LinkedIn and get HR contact emails'), true);
  assert.equal(router.requestedContactEnrichment('now enrich those leads with email and number using Apollo'), true);
  assert.equal(router.isApolloEnrichmentRequest('now enrich those leads with email and number using Apollo'), true);
}

if (run('location')) {
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
}

if (run('workspace')) {
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
  assert.equal(
    router.isSetWorkspaceRequest('Use https://docs.google.com/spreadsheets/d/master123/edit as my current LinkedIn sheet'),
    true
  );
}

if (run('refinement')) {
  const mission = {
    status: 'completed',
    requested: 20,
    added: 7,
    sheetUrl: 'https://docs.google.com/spreadsheets/d/master123/edit',
    filterVerification: {
      rejected: { work_type: 11, employee_count: 7, location: 4 },
    },
    request: {
      count: 20,
      entityMode: 'company',
      hiring: true,
      topic: 'SAP',
      location: 'Maharashtra',
      locationScope: 'job',
      filters: {
        workType: 'remote',
        employeeMin: null,
        employeeMax: 1000,
        jobType: null,
        experienceLevel: null,
        datePosted: null,
        easyApply: false,
      },
    },
  };

  assert.equal(router.isMissionRefinementRequest('remove the remote filter and expand to all India', mission), true);
  const expanded = router.buildMissionRefinement(
    'remove the remote filter and expand to all India',
    mission,
    'https://docs.google.com/spreadsheets/d/master123/edit'
  );
  assert.equal(expanded.request.location, 'India');
  assert.equal(expanded.request.filters.workType, null);
  assert.equal(expanded.request.filters.employeeMax, 1000);
  assert.equal(expanded.request.count, 13);
  assert.equal(expanded.request.destinationSheetUrl, 'https://docs.google.com/spreadsheets/d/master123/edit');

  const bigger = router.buildMissionRefinement(
    'keep the same search but allow up to 2000 employees and add 5 more companies',
    mission,
    'https://docs.google.com/spreadsheets/d/master123/edit'
  );
  assert.equal(bigger.request.filters.employeeMax, 2000);
  assert.equal(bigger.request.count, 5);
  assert.equal(bigger.request.location, 'Maharashtra');
  assert.equal(bigger.request.filters.workType, 'remote');

  const noLocation = router.buildMissionRefinement(
    'remove location filter and add 10 more companies',
    mission,
    'https://docs.google.com/spreadsheets/d/master123/edit'
  );
  assert.equal(noLocation.request.location, '');
  assert.equal(noLocation.request.count, 10);

  const naturalPune = router.buildMissionRefinement(
    'same but Pune only',
    mission,
    'https://docs.google.com/spreadsheets/d/master123/edit'
  );
  assert.equal(naturalPune.request.location, 'Pune');
  assert.equal(naturalPune.request.count, 13);

  const pune = router.buildMissionRefinement(
    'same search but location to Pune',
    mission,
    'https://docs.google.com/spreadsheets/d/master123/edit'
  );
  assert.equal(pune.request.location, 'Pune');
  assert.equal(pune.request.count, 13);

  const total = router.buildMissionRefinement(
    'make the total 20 companies',
    mission,
    'https://docs.google.com/spreadsheets/d/master123/edit'
  );
  assert.equal(total.request.count, 13);

  const indiaThirty = router.buildMissionRefinement(
    'add more for remote SAP roles and make the list go 30. search roles within India',
    mission,
    'https://docs.google.com/spreadsheets/d/master123/edit'
  );
  assert.equal(indiaThirty.request.location, 'India');
  assert.equal(indiaThirty.request.filters.workType, 'remote');
  assert.equal(indiaThirty.request.filters.employeeMax, 1000);
  assert.equal(indiaThirty.request.targetMode, 'master_total');
  assert.equal(indiaThirty.request.targetTotal, 30);
  assert.equal(indiaThirty.request.count, 23);
  assert.equal(indiaThirty.request.locationPolicy.scope, 'India');
  assert.equal(indiaThirty.request.locationPolicy.allowOtherIndia, true);

  assert.equal(router.autoRelaxCandidate(mission).key, 'work_type');
  const autoRelaxed = router.buildMissionRefinement(
    'remove the biggest blocking filter and fill the remaining companies',
    mission,
    'https://docs.google.com/spreadsheets/d/master123/edit'
  );
  assert.equal(autoRelaxed.request.filters.workType, null);
  assert.equal(autoRelaxed.request.filters.employeeMax, 1000);
  assert.equal(autoRelaxed.request.location, 'Maharashtra');
  assert.equal(autoRelaxed.request.count, 13);

  const relaxed = router.buildMissionRefinement(
    'remove the employee limit, remove remote, expand to India and fill the remaining companies',
    mission,
    'https://docs.google.com/spreadsheets/d/master123/edit'
  );
  assert.equal(relaxed.request.filters.employeeMin, null);
  assert.equal(relaxed.request.filters.employeeMax, null);
  assert.equal(relaxed.request.filters.workType, null);
  assert.equal(relaxed.request.location, 'India');
  assert.equal(relaxed.request.count, 13);
}

if (run('sheet')) {
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
}

console.log(`LinkedIn command router self-test passed (${group}): global locations, generic role cleanup, explicit Apollo/contact intent, master-total mission refinements, master-sheet routing and safe column edits are healthy.`);
