#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');

require('../core/universal-deterministic-bootstrap').install();
const schemaTools = require('../core/universal-sheet-schema');
const engine = require('../core/universal-enrichment-engine');
const planner = require('../core/universal-enrichment-planner');
const writeScope = require('../core/universal-enrichment-write-scope');
const runContext = require('../core/universal-run-context');
const operator = require('../core/universal-sheet-enrichment-operator');
const targeted = require('../core/universal-sheet-enrichment-targeted');
const controlPlane = require('../core/universal-enrichment-control-plane');

const headers = ['COMPANY NAME','COMPANY LINK','1st POC NAME','PHONE','EMAIL','2ND POC NAME','PHONE','EMAIL'];
const anchorRow = ['Abhishek Tiwari','ID: https://www.linkedin.com/in/abhishek-tiwari-31174012a/','','','','','',''];
const rows = [headers, anchorRow, ['Riya Sharma','https://www.linkedin.com/in/riya-sharma/','','','','','',''], ['Karan Mehta','https://www.linkedin.com/in/karan-mehta/','','','','','','']];

(async () => {
  const originalFetch = global.fetch;
  let providerCalls = 0;
  global.fetch = async () => { providerCalls++; throw new Error('provider calls are forbidden in this fixture'); };
  try {
    const schema = schemaTools.inferSchema(rows, { expectedPersonGroups: 2 });
    const poc1 = schema.personGroups.find((group) => Number(group.ordinal) === 1);
    const poc2 = schema.personGroups.find((group) => Number(group.ordinal) === 2);
    assert.deepEqual([poc1.fields.name.index, poc1.fields.phone.index, poc1.fields.email.index], [2,3,4]);
    assert.deepEqual([poc2.fields.name.index, poc2.fields.phone.index, poc2.fields.email.index], [5,6,7]);
    assert.equal(poc1.fields.linkedin, undefined, 'B must be detached from POC-1 ownership');
    assert.deepEqual(schema.rowSemanticAnchorHints.map((hint) => [hint.nameColumnIndex, hint.linkedinColumnIndex]), [[0,1]]);

    const analysis = engine.analyzeSheet(rows, { schema: { expectedPersonGroups: 2 } });
    const record = analysis.rowPlans[0];
    assert.equal(record.plan.anchor.type, 'person');
    assert.equal(record.plan.anchor.semanticRecovery, true);
    assert.equal(record.plan.anchor.snapshot.values.name, 'Abhishek Tiwari');
    assert.equal(schemaTools.linkedInKind(record.plan.anchor.snapshot.values.linkedin), 'linkedin_person');
    assert.equal(record.plan.context.company, undefined, 'the person name in A2 must not become company context');
    assert.deepEqual(record.plan.groups.open.map((item) => item.group.ordinal), [1,2]);
    assert.equal(record.plan.groups.existing.length, 0, 'A/B anchor evidence must not satisfy either requested POC slot');

    const scope = writeScope.compile('resume enrichment the companies in this sheet with number and email of 1st poc and 2nd poc', schema);
    assert.deepEqual(scope.requestedFields.sort(), ['email','phone']);
    assert.deepEqual([...new Set(scope.allowed.map((item) => item.columnIndex))].sort((a,b) => a-b), [2,3,4,5,6,7]);
    assert.equal(scope.allowed.find((item) => item.columnIndex === 2)?.supporting, true);
    assert.equal(scope.allowed.find((item) => item.columnIndex === 5)?.supporting, true);
    assert.equal(scope.protectedColumns.some((item) => item.columnIndex === 0), true);
    assert.equal(scope.protectedColumns.some((item) => item.columnIndex === 1), true);

    runContext.run({ writeScope: scope }, () => {
      const poc1Writes = planner.safeWritesForGroup(anchorRow, poc1, { name:'Verified One', phone:'+919876543210', email:'one@example.com', title:'HR Director' }).writes;
      const poc2Writes = planner.safeWritesForGroup(anchorRow, poc2, { name:'Verified Two', phone:'+919876543211', email:'two@example.com', title:'Talent Head' }).writes;
      assert.deepEqual(poc1Writes.map((write) => write.columnIndex).sort(), [2,3,4]);
      assert.deepEqual(poc2Writes.map((write) => write.columnIndex).sort(), [5,6,7]);
      assert.doesNotThrow(() => writeScope.assertChanges(scope, { schema }, [...poc1Writes, ...poc2Writes]));
      assert.equal([...poc1Writes, ...poc2Writes].some((write) => write.columnIndex < 2), false);
    });

    const restricted = writeScope.compile('enrich phone and email of 1st and 2nd poc; do not change poc names', schema);
    runContext.run({ writeScope: restricted }, () => {
      const blocked = planner.safeWritesForGroup(anchorRow, poc1, { name:'Verified One', phone:'+919876543210', email:'one@example.com' });
      assert.equal(blocked.allowed, false, 'an empty slot cannot receive ownerless contacts when names are explicitly prohibited');
    });

    const executed = [];
    const checkpoints = [];
    for (const rowNumber of [2,3,4]) {
      executed.push(rowNumber);
      if (rowNumber !== 2) continue;
      const typed = operator.typedFailureSummary(Object.assign(new Error('candidate-specific mismatch'), {
        code:'APOLLO_CANDIDATE_MISMATCH', subsystem:'APOLLO', errorType:'API', stage:'candidate-verification',
      }));
      const disposition = operator.rowFailureDisposition(typed, {}, {});
      checkpoints.push({ rowNumber, state: disposition.checkpointState });
      assert.equal(disposition.action, 'continue');
    }
    assert.deepEqual(executed, [2,3,4]);
    assert.deepEqual(checkpoints, [{ rowNumber:2, state:'RETRY_REQUIRED' }]);

    const originalRead = operator.readUniversalSheet;
    operator.readUniversalSheet = async () => ({ spreadsheetId:'fixture', sheetName:'Aryatry', rows, schema });
    try {
      const gate = await targeted.mandatoryCompletionAudit(
        { sheetUrl:'https://docs.google.com/spreadsheets/d/fixture/edit', sheetName:'Aryatry' },
        { expectedPersonGroups:2, targetRowSelection:{ startRow:3, endRow:4 } },
      );
      assert.deepEqual(gate.checkedRows, [3,4], 'completion audit must not inspect rows before the selected forward range');
    } finally {
      operator.readUniversalSheet = originalRead;
    }

    const inspection = { rows:[headers, ['', '', 'Existing name only','','','','',''], ['', '', '', '+919999999999','','','','']], analysis:{ rowPlans:[{rowNumber:2},{rowNumber:3}] } };
    const frontier = controlPlane.recoverForwardFrontier({ writeScope:scope, rowCheckpoints:{}, startRow:2, endRow:3 }, inspection);
    assert.equal(frontier.nextRow, 4, 'requested phone evidence may advance the frontier');
    inspection.rows[2][3] = '';
    const identityOnly = controlPlane.recoverForwardFrontier({ writeScope:scope, rowCheckpoints:{}, startRow:2, endRow:3 }, inspection);
    assert.equal(identityOnly.nextRow, 2, 'supporting POC names must not advance a contact-only frontier');
    assert.equal(providerCalls, 0, 'schema inspection, planning and approval preparation must not call Apollo');

    console.log('Aryatry semantic regression passed: A/B recover as read-only person-anchor evidence, C:E and F:H remain POC-1/POC-2, supporting owners stay scope-safe, row-local failure continues to rows 3/4, audits honor the forward range, and no provider call occurs before approval.');
  } finally {
    global.fetch = originalFetch;
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
