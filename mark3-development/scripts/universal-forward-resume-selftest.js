#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-forward-resume-'));
process.env.ULTRON_M3_ENRICHMENT_MISSION_STORE = path.join(tempDir, 'missions.json');

const missionStore = require('../core/universal-enrichment-mission-store');
const controlPlane = require('../core/universal-enrichment-control-plane');
const commandControl = require('../core/command-control-plane');
const writeScope = require('../core/universal-enrichment-write-scope');
const linkedinOperator = require('../core/linkedin-account-operator');
require('../core/universal-deterministic-bootstrap').install();
const schemaTools = require('../core/universal-sheet-schema');
const schemaSafety = require('../core/universal-schema-safety');

try {
  assert.equal(controlPlane.isResume('resume enrichment'), true);
  assert.equal(controlPlane.isRetryUnresolved('retry unresolved enrichment'), true);
  assert.equal(controlPlane.isRetryUnresolved('backfill unresolved rows'), true);
  assert.equal(linkedinOperator.isContinueSearchRequest('resume enrichment'), false);
  assert.equal(linkedinOperator.isContinueSearchRequest('continue enrichment'), false);

  const url = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890/edit?gid=1229007269#gid=1229007269';
  const incident = commandControl.claim([
    `google sheet url: ${url}`,
    'worksheet name - Arya-24 sept.',
    'enrich the companies in this sheet with number and email of 1st poc and 2nd poc',
  ].join('\n'));
  assert.equal(incident.domain, 'spreadsheet-enrichment');
  assert.equal(incident.controller, 'universal-spreadsheet-domain-controller');

  const headers = [
    'COMPANY NAME', 'COMPANY LINK',
    '1st POC NAME', 'PHONE', 'EMAIL',
    '2ND POC NAME', 'PHONE', 'EMAIL',
    'Outcome',
    'APOLLO CONTACT', 'APOLLO ROLE', 'APOLLO LINKEDIN',
    'APOLLO PHONE', 'APOLLO EMAIL', 'APOLLO STATUS',
  ];
  assert.equal(linkedinOperator.explicitPocHeaderContract(headers), true);

  const liveShapeRows = [
    headers.slice(),
    [
      'Koncepts Lab',
      'http://www.linkedin.com/company/koncepts-lab',
      'Firose Babu — Director, Chief Administrative Officer (CAO)',
      '+971526224528',
      'firose@konceptslab.com',
      '', '', '', '',
      'Firose Babu',
      'Director, Chief Administrative Officer (CAO)',
      'https://www.linkedin.com/in/firose-babu-786a04271',
      '+971526224528',
      'firose@konceptslab.com',
      'ENRICHED',
    ],
    [
      'MindBrain',
      'http://www.linkedin.com/company/mindbrain',
      'Shubham Mohapatra — Founder & CEO',
      '+919178587486',
      'shubham.m@mindbrain.co.in',
      'Sebastian Drees — Managing Director',
      '+4923089769770',
      'sebastian.drees@mindbrain.de',
      '',
      'Shubham Mohapatra',
      'Founder & CEO',
      'https://www.linkedin.com/in/shubhambytes',
      '+919178587486',
      'shubham.m@mindbrain.co.in',
      'ENRICHED',
    ],
  ];
  const inferredLiveShape = schemaTools.inferSchema(liveShapeRows, { expectedPersonGroups: 2 });
  const inferredSafety = schemaSafety.assess(inferredLiveShape);
  const inferredPoc1 = inferredLiveShape.personGroups.find((group) => Number(group.ordinal) === 1);
  const inferredPoc2 = inferredLiveShape.personGroups.find((group) => Number(group.ordinal) === 2);
  assert.equal(inferredSafety.safe, true, `live Arya-24 sept A:O schema must remain safe: ${inferredSafety.questions.join(' | ')}`);
  assert.equal(inferredPoc1?.fields?.phone?.index, 3);
  assert.equal(inferredPoc1?.fields?.email?.index, 4);
  assert.equal(inferredPoc2?.fields?.phone?.index, 6);
  assert.equal(inferredPoc2?.fields?.email?.index, 7);
  assert.ok(
    !(inferredPoc2?.alternates || []).some((item) => [12, 13].includes(Number(item.index))),
    'APOLLO PHONE/EMAIL must never become POC-2 alternate ownership candidates',
  );

  const schema = {
    columns: headers.map((header, index) => ({ index, header, role: 'unknown' })),
    personGroups: [
      {
        id: 'poc-1',
        ordinal: 1,
        fields: {
          name: { index: 2 },
          phone: { index: 3 },
          email: { index: 4 },
        },
      },
      {
        id: 'poc-2',
        ordinal: 2,
        fields: {
          name: { index: 5 },
          phone: { index: 6 },
          email: { index: 7 },
        },
      },
    ],
  };

  const scope = writeScope.compile(
    'enrich the companies with number and email of 1st poc and 2nd poc',
    schema,
  );
  assert.deepEqual(
    [...new Set(scope.allowed.map((item) => item.columnIndex))].sort((a, b) => a - b),
    [3, 4, 6, 7],
    'requested phone/email scope must not include Outcome or the accidental APOLLO section',
  );

  const rows = Array.from({ length: 173 }, () => Array(15).fill(''));
  rows[0] = headers.slice();
  rows[168][0] = 'SYSCRAFT INFORMATION SYSTEM PVT. LTD.';
  rows[168][1] = 'https://www.linkedin.com/company/syscraft-information-system';
  rows[168][2] = 'Sagar Medhekar — Business Development Manager';
  rows[168][3] = '+919893324281';

  // Simulate data in the accidental dedicated Apollo section after the intended
  // forward frontier. It must not move the recovery cursor because J:O is outside
  // the universal mission WriteScope.
  rows[171][9] = 'Wrong-path Apollo Contact';
  rows[171][12] = '+911234567890';

  const rowPlans = [];
  for (let rowNumber = 2; rowNumber <= 172; rowNumber++) rowPlans.push({ rowNumber });
  const inspection = {
    rows,
    analysis: { rowPlans },
  };
  const mission = {
    writeScope: scope,
    rowCheckpoints: {},
    startRow: 2,
    endRow: 172,
  };

  const recovered = controlPlane.recoverForwardFrontier(mission, inspection);
  assert.equal(recovered.lastProcessedRow, 169);
  assert.equal(recovered.nextRow, 170);
  assert.equal(recovered.endRow, 172);
  assert.equal(recovered.source, 'sheet-write-scope-recovery');

  const durable = missionStore.create({
    spreadsheetId: 'sheet-1',
    spreadsheetUrl: url,
    sheetName: 'Arya-24 sept',
    sheetId: 1229007269,
    startRow: 2,
    endRow: 172,
    totalEligibleRows: 171,
    writeScope: scope,
  });
  missionStore.checkpointRow(durable.missionId, 10, { state: 'COMPLETE', processed: true });
  missionStore.checkpointRow(durable.missionId, 5, { state: 'NO_VERIFIED_PERSON', processed: true });
  const saved = missionStore.get(durable.missionId);
  assert.equal(saved.lastProcessedRow, 10, 'historical checkpoints must never rewind the forward frontier');
  assert.equal(saved.nextRow, 11);

  console.log('Forward enrichment resume regression passed: POC Google requests stay universal, worksheet-name labels parse correctly, accidental APOLLO columns cannot contaminate POC ownership or resume recovery, and the durable cursor advances monotonically.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
