#!/usr/bin/env node
const assert = require('assert');
const router = require('../core/linkedin-command-router');
const controlPlane = require('../core/command-control-plane');

const group = String(process.env.ULTRON_LINKEDIN_COMMAND_TEST_GROUP || 'all').trim().toLowerCase();
const run = (name) => group === 'all' || group === name;

if (run('intent')) {
  assert.equal(router.requestedContactEnrichment('Find 20 SAP companies on LinkedIn in Maharashtra'), false);
  assert.equal(router.requestedContactEnrichment('Find 20 SAP companies on LinkedIn and get HR contact emails'), true);
  assert.equal(router.requestedContactEnrichment('now enrich those leads with email and number using Apollo'), true);
  assert.equal(router.isApolloEnrichmentRequest('now enrich those leads with email and number using Apollo'), true);
  assert.equal(router.isApolloEnrichmentRequest('also add their numbers using apollo'), true);

  const discoveryOnlySheetCommand = 'Find 30 unique companies with active SAP job openings in Mumbai, posted within the past week. Remote jobs only. Write the results into https://docs.google.com/spreadsheets/d/1KZKJAe-QqZcreG3mr32JNbdiwBYDFWndynaXqid8wKY/edit?gid=306985105#gid=306985105 Sheet Arya-22 sept. Discovery only—do not find POCs, emails, or phone numbers, and do not use Apollo. Continue through pagination and relevant SAP role variants until the target is reached or all safe search strategies are exhausted.';
  assert.equal(router.requestedContactEnrichment(discoveryOnlySheetCommand), false);
  assert.equal(router.isApolloEnrichmentRequest(discoveryOnlySheetCommand), false);
  assert.equal(controlPlane.isUniversalSpreadsheetEnrichmentRequest(discoveryOnlySheetCommand), false);
  const discoveryOnlySheetRoute = controlPlane.claim(discoveryOnlySheetCommand);
  assert.equal(discoveryOnlySheetRoute.domain, 'linkedin');
  assert.equal(discoveryOnlySheetRoute.controller, 'linkedin-domain-controller');
  assert.equal(discoveryOnlySheetRoute.exclusive, true);

  const anchoredPocCommand = [
    'Use @New_Sheet_14-09-25 and perform the Mark 3 anchored 3-POC enrichment.',
    'Person or Company Name = POC-1 name.',
    'LinkedIn Id = POC-1 person LinkedIn profile.',
    '2nd POC Name has its own phone and email.',
    '3rd POC has its own phone and email.',
    'Resolve POC-1 current employer and enrich the three POCs.',
  ].join(' ');
  const anchoredPocOptions = {
    attachments: [{
      id: 'file-three-poc',
      name: 'New_Sheet_14-09-25.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }],
  };
  assert.equal(controlPlane.isLocalThreePocWorkbookRequest(anchoredPocCommand, anchoredPocOptions), true);
  const anchoredRoute = controlPlane.claim(anchoredPocCommand, anchoredPocOptions);
  assert.equal(anchoredRoute.domain, 'three-poc-spreadsheet');
  assert.equal(anchoredRoute.exclusive, true);
  assert.equal(anchoredRoute.claimed, true);
  assert.equal(anchoredRoute.controller, 'three-poc-domain-controller');
  assert.equal(anchoredRoute.generalModelAllowed, false);

  const attachmentOnlyPocCommand = [
    'Perform anchored 3-POC enrichment on the attached workbook.',
    'Person or Company Name is POC-1 and LinkedIn Id is that person profile.',
    'Fill POC-2 and POC-3 with respective phone and email.',
  ].join(' ');
  const attachmentOnlyRoute = controlPlane.claim(attachmentOnlyPocCommand, anchoredPocOptions);
  assert.equal(attachmentOnlyRoute.domain, 'three-poc-spreadsheet');
  assert.equal(attachmentOnlyRoute.exclusive, true);
  assert.equal(attachmentOnlyRoute.controller, 'three-poc-domain-controller');

  const googleThreePocCommand = [
    'Use https://docs.google.com/spreadsheets/d/testSheet123/edit#gid=123 and perform the Mark 3 anchored 3-POC enrichment.',
    'Person or Company Name = POC-1 name.',
    'LinkedIn Id = POC-1 person LinkedIn profile.',
    '2nd POC Name has its own phone and email.',
    '3rd POC has its own phone and email.',
  ].join(' ');
  assert.equal(controlPlane.isThreePocSpreadsheetRequest(googleThreePocCommand), true);
  const googleThreePocRoute = controlPlane.claim(googleThreePocCommand);
  assert.equal(googleThreePocRoute.domain, 'three-poc-spreadsheet');
  assert.equal(googleThreePocRoute.exclusive, true);
  assert.equal(googleThreePocRoute.claimed, true);
  assert.equal(googleThreePocRoute.controller, 'three-poc-domain-controller');
  assert.equal(googleThreePocRoute.generalModelAllowed, false);

  const normalLinkedInRoute = controlPlane.claim('Find 20 SAP companies on LinkedIn in Maharashtra with active job openings');
  assert.equal(normalLinkedInRoute.domain, 'linkedin');
  assert.equal(normalLinkedInRoute.exclusive, true);

  const savedFirstText = 'LinkedIn only: Find enough NEW unique companies with active SAP job openings to make my Final Master reach exactly 30 verified companies total. Reuse saved discovery, cached evidence and previously rejected candidates before making unnecessary fresh LinkedIn calls. Do not use Apollo yet.';
  const savedFirst = router.enhanceRequest({
    criteriaText: savedFirstText,
    entityMode: 'company',
    hiring: true,
    topic: 'SAP',
    filters: { employeeMax: 1000 },
    destinationSheetUrl: 'https://docs.google.com/spreadsheets/d/master123/edit',
  }, savedFirstText, 'https://docs.google.com/spreadsheets/d/master123/edit');
  assert.equal(router.reuseExistingEvidenceFromText(savedFirstText), true);
  assert.equal(savedFirst.resumeExistingPool, true);
  assert.equal(savedFirst.reuseCachedEvidence, true);
  assert.equal(savedFirst.wantsContacts, false);
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

  assert.equal(
    router.isMissionRefinementRequest(
      'LinkedIn only: Find enough NEW unique companies with active SAP job openings to make my Final Master reach exactly 30 verified companies total. Locations: Maharashtra and Bengaluru. Remote roles preferred. Maximum 1000 employees.',
      mission
    ),
    false
  );
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

  assert.equal(expanded.request.missionContract.hard.locations[0], 'India');
  assert.equal(expanded.request.missionContract.hard.workType, null);

  const bigger = router.buildMissionRefinement(
    'keep the same search but allow up to 2000 employees and add 5 more companies',
    mission,
    'https://docs.google.com/spreadsheets/d/master123/edit'
  );
  assert.equal(bigger.request.filters.employeeMax, 2000);
  assert.equal(bigger.request.count, 5);
  assert.equal(bigger.request.location, 'Maharashtra');
  assert.equal(bigger.request.filters.workType, 'remote');

  const preferredRemote = router.buildMissionRefinement(
    'keep SAP and India, but remote roles are preferred rather than required',
    { ...mission, request: { ...mission.request, location: 'India' } },
    'https://docs.google.com/spreadsheets/d/master123/edit'
  );
  assert.equal(preferredRemote.request.filters.workType, null);
  assert.equal(preferredRemote.request.preferredWorkType, 'remote');
  assert.equal(preferredRemote.request.missionContract.preferences.workType, 'remote');

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
