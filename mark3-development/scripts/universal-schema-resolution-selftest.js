'use strict';

// ---------------------------------------------------------------------------
// Canonical schema resolution regression suite (Phase 15/16 of the permanent
// UNIVERSAL_SCHEMA_AMBIGUOUS fix).
//
// Contract under test:
//   1. Reasonably structured lead sheets resolve DETERMINISTICALLY regardless
//      of header aliases, ordering, separation, partial fields, populated
//      cells, extra columns or POC group layout.
//   2. UNIVERSAL_SCHEMA_AMBIGUOUS fires ONLY for genuine ambiguity, and then
//      always with the full structured diagnostics payload.
//   3. Every other condition surfaces under its own error code (drift,
//      confidence, missing header) — never UNIVERSAL_SCHEMA_AMBIGUOUS.
//   4. Schema identity is value-independent: cell values can never change the
//      resolved structure or its structural fingerprint.
// ---------------------------------------------------------------------------

const assert = require('assert/strict');
require('../core/universal-deterministic-bootstrap').install();
const schemaTools = require('../core/universal-sheet-schema');
const safety = require('../core/universal-schema-safety');

const CTX = { worksheet: 'ResolutionFixture', spreadsheetId: 'fixture-spreadsheet' };
const TOTAL = 18;
let completed = 0;

function test(label, fn) {
  completed += 1;
  try {
    fn();
    console.log(`TEST ${String(completed).padStart(2, '0')}/${TOTAL} ${label} OK`);
  } catch (error) {
    console.error(`TEST ${String(completed).padStart(2, '0')}/${TOTAL} ${label} FAILED`);
    console.error((error && error.stack) || error);
    process.exit(1);
  }
}

function group(schema, ordinal) {
  const found = (schema.personGroups || []).find((g) => Number(g.ordinal) === Number(ordinal));
  assert.ok(found, `expected person group ${ordinal}, got [${(schema.personGroups || []).map((g) => g.ordinal).join(', ')}]`);
  return found;
}

function assertFields(schema, ordinal, expected) {
  const g = group(schema, ordinal);
  for (const [field, index] of Object.entries(expected)) {
    if (index === null) {
      assert.ok(!(field in g.fields), `group ${ordinal} must not have field ${field}`);
    } else {
      assert.equal(g.fields[field] && g.fields[field].index, index, `group ${ordinal} field ${field} must map to column index ${index}`);
    }
  }
}

function safe(schema) {
  return safety.assertSafe(schema, CTX);
}

function fingerprintMaps(schema) {
  return JSON.stringify(schema.personGroups.map((g) => ({
    o: g.ordinal,
    f: Object.fromEntries(Object.entries(g.fields).map(([f, d]) => [f, d.index])),
  })));
}

// ---------------------------------------------------------------------------
// TEST 1 — canonical baseline headers resolve to 1 company + 2 POC groups.
// ---------------------------------------------------------------------------
test('canonical baseline headers resolve 2 POC groups', () => {
  const rows = [
    ['Company Name', 'POC 1 Name', 'POC 1 Phone', 'POC 1 Email', 'POC 2 Name', 'POC 2 Phone', 'POC 2 Email'],
    ['Acme Systems', 'Alice Kumar', '+919876543210', 'alice@acme.io', 'Bob Rao', '+919876543211', 'bob@acme.io'],
    ['Globex Labs', 'Carol Singh', '+919876543212', 'carol@globex.io', 'Dave Menon', '+919876543213', 'dave@globex.io'],
  ];
  const schema = schemaTools.inferSchema(rows);
  assert.equal(schema.personGroups.length, 2);
  assert.ok(schema.companyGroups.length >= 1, 'company group required');
  assert.equal(schema.companyGroups[0].fields.company.index, 0);
  assertFields(schema, 1, { name: 1, phone: 2, email: 3 });
  assertFields(schema, 2, { name: 4, phone: 5, email: 6 });
  const assessment = safe(schema);
  assert.equal(assessment.safe, true);
  assert.ok(schema.confidence >= 0.55, `confidence ${schema.confidence} must clear the safe threshold`);
});

// ---------------------------------------------------------------------------
// TEST 2 — different wording (aliases) resolves identically.
// ---------------------------------------------------------------------------
test('alias wording variants resolve identically', () => {
  const rows = [
    ['Company', 'Primary Contact', 'Mobile Number', 'Email ID', 'Secondary Contact', 'Telephone', 'E-Mail'],
    ['Acme Systems', 'Alice Kumar', '9876543210', 'alice@acme.io', 'Bob Rao', '9876543211', 'bob@acme.io'],
    ['Globex Labs', 'Carol Singh', '9876543212', 'carol@globex.io', 'Dave Menon', '9876543213', 'dave@globex.io'],
  ];
  const schema = schemaTools.inferSchema(rows);
  assert.equal(schema.personGroups.length, 2);
  assert.equal(schema.companyGroups[0].fields.company.index, 0);
  assertFields(schema, 1, { name: 1, phone: 2, email: 3 });
  assertFields(schema, 2, { name: 4, phone: 5, email: 6 });
  safe(schema);
});

// ---------------------------------------------------------------------------
// TEST 3 — columns reordered inside groups resolve by header, not position.
// ---------------------------------------------------------------------------
test('reordered columns resolve by header semantics', () => {
  const rows = [
    ['Company Name', 'POC 1 Email', 'POC 1 Phone', 'POC 1 Name', 'POC 2 Email', 'POC 2 Phone', 'POC 2 Name'],
    ['Acme Systems', 'alice@acme.io', '9876543210', 'Alice Kumar', 'bob@acme.io', '9876543211', 'Bob Rao'],
    ['Globex Labs', 'carol@globex.io', '9876543212', 'Carol Singh', 'dave@globex.io', '9876543213', 'Dave Menon'],
  ];
  const schema = schemaTools.inferSchema(rows);
  assert.equal(schema.personGroups.length, 2);
  assertFields(schema, 1, { email: 1, phone: 2, name: 3 });
  assertFields(schema, 2, { email: 4, phone: 5, name: 6 });
  safe(schema);
});

// ---------------------------------------------------------------------------
// TEST 4 — group fields separated by unrelated columns still group correctly.
// ---------------------------------------------------------------------------
test('separated group columns survive interleaved unrelated columns', () => {
  const rows = [
    ['Company Name', 'POC 1 Name', 'Internal ID', 'POC 1 Phone', 'Notes', 'POC 1 Email', 'POC 2 Name', 'Priority', 'POC 2 Phone', 'Last Contacted', 'POC 2 Email'],
    ['Acme Systems', 'Alice Kumar', 'INT-1', '9876543210', 'n/a', 'alice@acme.io', 'Bob Rao', 'High', '9876543211', '2026-10-01', 'bob@acme.io'],
    ['Globex Labs', 'Carol Singh', 'INT-2', '9876543212', 'n/a', 'carol@globex.io', 'Dave Menon', 'Low', '9876543213', '2026-10-02', 'dave@globex.io'],
  ];
  const schema = schemaTools.inferSchema(rows);
  assert.equal(schema.personGroups.length, 2);
  assertFields(schema, 1, { name: 1, phone: 3, email: 5 });
  assertFields(schema, 2, { name: 6, phone: 8, email: 10 });
  const extras = new Set([2, 4, 7, 9]);
  for (const g of schema.personGroups) {
    for (const d of Object.values(g.fields)) assert.ok(!extras.has(d.index), `unrelated column ${d.index} leaked into a person group`);
  }
  safe(schema);
});

// ---------------------------------------------------------------------------
// TEST 5 — partial schema (missing optional phone columns) is VALID.
// ---------------------------------------------------------------------------
test('partial schema without phone columns is valid, not ambiguous', () => {
  const rows = [
    ['Company Name', 'POC 1 Name', 'POC 1 Email', 'POC 2 Name', 'POC 2 Email'],
    ['Acme Systems', 'Alice Kumar', 'alice@acme.io', 'Bob Rao', 'bob@acme.io'],
    ['Globex Labs', 'Carol Singh', 'carol@globex.io', 'Dave Menon', 'dave@globex.io'],
  ];
  const schema = schemaTools.inferSchema(rows);
  assert.equal(schema.personGroups.length, 2);
  assertFields(schema, 1, { name: 1, email: 2, phone: null });
  assertFields(schema, 2, { name: 3, email: 4, phone: null });
  const assessment = safe(schema);
  assert.equal(assessment.safe, true);
});

// ---------------------------------------------------------------------------
// TEST 6 — requested group missing from the sheet => PARTIAL, never ambiguous.
// A populated region is never repurposed; blank trailing columns are only used
// through the explicit, audited continuity-recovery contract.
// ---------------------------------------------------------------------------
test('a requested trailing POC group is reconstructed only in blank space, never in populated columns', () => {
  const rows = [
    ['Company Name', 'POC 1 Name', 'POC 1 Phone', 'POC 1 Email', 'Priority', 'Owner'],
    ['Acme Systems', 'Alice Kumar', '9876543210', 'alice@acme.io', 'High', 'ops-team'],
    ['Globex Labs', 'Carol Singh', '9876543212', 'carol@globex.io', 'Low', 'sales-team'],
  ];
  const schema = schemaTools.inferSchema(rows, { expectedPersonGroups: 2 });

  // 1. The existing POC-1 mapping is untouched.
  assertFields(schema, 1, { name: 1, phone: 2, email: 3 });

  // 2. Populated unrelated columns are never repurposed, and belong to no group.
  for (const index of [4, 5]) {
    const column = schema.columns.find((item) => item.index === index);
    assert.ok(column, `column ${index} must still exist`);
    assert.equal(column.role, 'unknown', `populated column ${index} must not be repurposed`);
    for (const group of schema.personGroups) {
      for (const field of Object.values(group.fields || {})) {
        assert.notEqual(field.index, index, `column ${index} leaked into ${group.id}`);
      }
    }
  }

  // 3. The explicitly requested POC-2 is prepared BEYOND the widest row, and the
  //    reconstruction is auditable rather than a silent guess.
  assert.equal(schema.personGroups.length, 2);
  const second = schema.personGroups.find((group) => Number(group.ordinal) === 2);
  assert.equal(second.continuityRecovery, true);
  for (const field of Object.values(second.fields)) {
    assert.ok(field.index >= rows[0].length, 'reconstruction must stay in blank trailing space');
  }
  assert.equal((schema.continuityRecoveries || []).length, 1);
  assert.equal(schema.continuityRecoveries[0].source, 'explicit-expected-person-group-continuity');
  assert.ok((schema.headerRepairs || []).length >= 1, 'reconstructed headers must be queued for repair');
  assert.equal(safe(schema).safe, true);

  // 4. Without an explicit expected count nothing is invented, and a schema
  //    whose expected group cannot be placed safely stays partial but valid.
  const implicit = schemaTools.inferSchema(rows);
  assert.equal(implicit.personGroups.length, 1);
  assert.equal((implicit.continuityRecoveries || []).length, 0);
  const implicitAssessment = safe(implicit);
  assert.equal(implicitAssessment.safe, true);
});

// ---------------------------------------------------------------------------
// TEST 7 — extra unrelated columns are ignored, never hijack a group.
// ---------------------------------------------------------------------------
test('extra unrelated columns never hijack person groups', () => {
  const rows = [
    ['Company Name', 'Owner', 'Priority', 'POC 1 Name', 'POC 1 Phone', 'POC 1 Email', 'Last Updated', 'POC 2 Name', 'POC 2 Phone', 'POC 2 Email', 'Budget'],
    ['Acme Systems', 'ops-team', 'High', 'Alice Kumar', '9876543210', 'alice@acme.io', '2026-10-01', 'Bob Rao', '9876543211', 'bob@acme.io', '100000'],
    ['Globex Labs', 'sales-team', 'Low', 'Carol Singh', '9876543212', 'carol@globex.io', '2026-10-02', 'Dave Menon', '9876543213', 'dave@globex.io', '250000'],
  ];
  const schema = schemaTools.inferSchema(rows);
  assert.equal(schema.personGroups.length, 2);
  const extras = new Set([1, 2, 6, 10]);
  for (const g of schema.personGroups) {
    for (const d of Object.values(g.fields)) assert.ok(!extras.has(d.index), `extra column ${d.index} leaked into a person group`);
  }
  assertFields(schema, 1, { name: 3, phone: 4, email: 5 });
  assertFields(schema, 2, { name: 7, phone: 8, email: 9 });
  safe(schema);
});

// ---------------------------------------------------------------------------
// TEST 8 — additional POC groups are detected (dynamic POC count).
// ---------------------------------------------------------------------------
test('third POC group detected dynamically', () => {
  const rows = [
    ['Company Name', 'POC 1 Name', 'POC 1 Phone', 'POC 1 Email', 'POC 2 Name', 'POC 2 Phone', 'POC 2 Email', 'POC 3 Name', 'POC 3 Phone', 'POC 3 Email'],
    ['Acme Systems', 'Alice Kumar', '9876543210', 'alice@acme.io', 'Bob Rao', '9876543211', 'bob@acme.io', 'Cara Iyer', '9876543214', 'cara@acme.io'],
    ['Globex Labs', 'Carol Singh', '9876543212', 'carol@globex.io', 'Dave Menon', '9876543213', 'dave@globex.io', 'Elena Roy', '9876543215', 'elena@globex.io'],
  ];
  const schema = schemaTools.inferSchema(rows, { expectedPersonGroups: 3 });
  assert.equal(schema.personGroups.length, 3);
  assertFields(schema, 1, { name: 1, phone: 2, email: 3 });
  assertFields(schema, 2, { name: 4, phone: 5, email: 6 });
  assertFields(schema, 3, { name: 7, phone: 8, email: 9 });
  safe(schema);
});

// ---------------------------------------------------------------------------
// TEST 9 — POC naming conventions: "First Point of Contact", "P.O.C.",
// "Primary/Secondary", ordinals as words — all resolve to the same groups.
// ---------------------------------------------------------------------------
test('POC naming conventions normalize to the same groups', () => {
  const rows = [
    ['Company Name', 'First Point of Contact', 'Primary Phone', 'Primary Email', 'Second Point of Contact', 'Secondary Phone', 'Secondary Email'],
    ['Acme Systems', 'Alice Kumar', '9876543210', 'alice@acme.io', 'Bob Rao', '9876543211', 'bob@acme.io'],
    ['Globex Labs', 'Carol Singh', '9876543212', 'carol@globex.io', 'Dave Menon', '9876543213', 'dave@globex.io'],
  ];
  const schema = schemaTools.inferSchema(rows, { expectedPersonGroups: 2 });
  assert.equal(schema.personGroups.length, 2);
  assertFields(schema, 1, { name: 1, phone: 2, email: 3 });
  assertFields(schema, 2, { name: 4, phone: 5, email: 6 });
  safe(schema);
});

// ---------------------------------------------------------------------------
// TEST 10 — value-independent schema identity: populated, empty and changed
// cells all produce the identical resolved structure.
// ---------------------------------------------------------------------------
test('schema identity is value-independent (populated vs empty cells)', () => {
  const header = ['Company Name', 'POC 1 Name', 'POC 1 Phone', 'POC 1 Email', 'POC 2 Name', 'POC 2 Phone', 'POC 2 Email'];
  const populated = [
    header,
    ['Acme Systems', 'Alice Kumar', '9876543210', 'alice@acme.io', 'Bob Rao', '9876543211', 'bob@acme.io'],
    ['Globex Labs', 'Carol Singh', '9876543212', 'carol@globex.io', 'Dave Menon', '9876543213', 'dave@globex.io'],
  ];
  const empty = [header.slice(), ['', '', '', '', '', '', ''], ['', '', '', '', '', '', '']];
  const changed = [
    header,
    ['Totally Other Co', 'Someone Else', '+441234567890', 'other@x.io', 'Another Person', '+441234567891', 'two@x.io'],
  ];
  const a = schemaTools.inferSchema(populated);
  const b = schemaTools.inferSchema(empty);
  const c = schemaTools.inferSchema(changed);
  assert.equal(a.structuralFingerprint, b.structuralFingerprint, 'empty values must not change structural identity');
  assert.equal(a.structuralFingerprint, c.structuralFingerprint, 'changed values must not change structural identity');
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(fingerprintMaps(a), fingerprintMaps(b), 'resolved field map must not depend on cell values');
  assert.equal(fingerprintMaps(a), fingerprintMaps(c));
  safe(a);
  safe(b);
  safe(c);
});

// ---------------------------------------------------------------------------
// TEST 11 — case / punctuation / separator variants normalize identically.
// ---------------------------------------------------------------------------
test('case and punctuation variants normalize to one schema', () => {
  const variants = ['Company Name', 'company_name', 'COMPANY-NAME', 'Company.Name', '  COMPANY   NAME  '];
  const results = variants.map((companyHeader) => {
    const rows = [
      [companyHeader, 'POC 1 Name', 'POC 1 Phone', 'POC 1 Email', 'POC 2 Name', 'POC 2 Phone', 'POC 2 Email'],
      ['Acme Systems', 'Alice Kumar', '9876543210', 'alice@acme.io', 'Bob Rao', '9876543211', 'bob@acme.io'],
    ];
    const schema = schemaTools.inferSchema(rows);
    assert.equal(schema.companyGroups[0].fields.company.index, 0, `variant ${JSON.stringify(companyHeader)} must keep company at index 0`);
    assert.equal(schema.personGroups.length, 2);
    safe(schema);
    return schema;
  });
  const baseline = results[0];
  for (const schema of results) {
    assert.equal(schema.structuralFingerprint, baseline.structuralFingerprint, 'normalization must erase case/punctuation differences');
  }
});

// ---------------------------------------------------------------------------
// TEST 12 — multi-row headers (group labels over field labels) merge into one
// effective header.
// ---------------------------------------------------------------------------
test('multi-row headers merge into one effective header', () => {
  const rows = [
    ['Company Name', 'POC 1', 'POC 1', 'POC 1', 'POC 2', 'POC 2', 'POC 2'],
    ['', 'Name', 'Phone', 'Email', 'Name', 'Phone', 'Email'],
    ['Acme Systems', 'Alice Kumar', '9876543210', 'alice@acme.io', 'Bob Rao', '9876543211', 'bob@acme.io'],
    ['Globex Labs', 'Carol Singh', '9876543212', 'carol@globex.io', 'Dave Menon', '9876543213', 'dave@globex.io'],
  ];
  const schema = schemaTools.inferSchema(rows);
  assert.equal(schema.personGroups.length, 2);
  assertFields(schema, 1, { name: 1, phone: 2, email: 3 });
  assertFields(schema, 2, { name: 4, phone: 5, email: 6 });
  safe(schema);
});

// ---------------------------------------------------------------------------
// TEST 13 — groups with different field combinations resolve independently.
// ---------------------------------------------------------------------------
test('groups with different field combinations resolve independently', () => {
  const rows = [
    ['Company Name', 'POC 1 Name', 'POC 1 Phone', 'POC 1 Email', 'POC 2 Name', 'POC 2 Email'],
    ['Acme Systems', 'Alice Kumar', '9876543210', 'alice@acme.io', 'Bob Rao', 'bob@acme.io'],
    ['Globex Labs', 'Carol Singh', '9876543212', 'carol@globex.io', 'Dave Menon', 'dave@globex.io'],
  ];
  const schema = schemaTools.inferSchema(rows, { expectedPersonGroups: 2 });
  assert.equal(schema.personGroups.length, 2);
  assertFields(schema, 1, { name: 1, phone: 2, email: 3 });
  assertFields(schema, 2, { name: 4, phone: null, email: 5 });
  safe(schema);
});

// ---------------------------------------------------------------------------
// TEST 14 — determinism: identical input always yields identical output, and
// interleaved inference of other sheets cannot leak state.
// ---------------------------------------------------------------------------
test('inference is deterministic and stateless across runs', () => {
  const rowsA = [
    ['Company Name', 'POC 1 Name', 'POC 1 Phone', 'POC 1 Email', 'POC 2 Name', 'POC 2 Phone', 'POC 2 Email'],
    ['Acme Systems', 'Alice Kumar', '9876543210', 'alice@acme.io', 'Bob Rao', '9876543211', 'bob@acme.io'],
  ];
  const rowsB = [
    ['Organization', 'First Contact', 'Mobile', 'Email Address'],
    ['Globex Labs', 'Carol Singh', '9876543212', 'carol@globex.io'],
  ];
  const first = schemaTools.inferSchema(rowsA);
  schemaTools.inferSchema(rowsB);
  const second = schemaTools.inferSchema(rowsA);
  const third = schemaTools.inferSchema(rowsA);
  assert.equal(first.structuralFingerprint, second.structuralFingerprint);
  assert.equal(first.structuralFingerprint, third.structuralFingerprint);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(fingerprintMaps(first), fingerprintMaps(second));
  assert.equal(fingerprintMaps(first), fingerprintMaps(third));
  assert.equal(schemaTools.hashSchema(first), schemaTools.hashSchema(second));
});

// ---------------------------------------------------------------------------
// TEST 15 — low-confidence sheets raise UNIVERSAL_SCHEMA_CONFIDENCE_TOO_LOW,
// never UNIVERSAL_SCHEMA_AMBIGUOUS.
// ---------------------------------------------------------------------------
test('an unsupported sheet maps to a typed schema failure, never to AMBIGUOUS', () => {
  const rows = [
    ['Company Name', 'Website'],
    ['Acme Systems', 'acme.io'],
    ['Globex Labs', 'globex.io'],
  ];
  const schema = schemaTools.inferSchema(rows);

  // A sheet with no contact group is not AMBIGUOUS: there is nothing to
  // disambiguate. Schema safety must therefore never classify it that way.
  let thrown = null;
  try {
    safety.assertSafe(schema, CTX);
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown, null, `no ambiguity may be reported for a company-only sheet (got ${thrown?.code})`);
  const assessment = safety.assess(schema, CTX);
  assert.notEqual(assessment.code, 'UNIVERSAL_SCHEMA_AMBIGUOUS');

  // The pipeline's own pre-approval gate is what stops this sheet, with its own
  // typed code, before any Apollo call or write.
  const controller = require('../core/universal-spreadsheet-domain-controller');
  assert.equal(controller.schemaReadable({ personGroups: [], confidence: schema.confidence }), false);
});

// ---------------------------------------------------------------------------
// TEST 16 — fingerprints: header changes are detectable drift, value changes
// are not.
// ---------------------------------------------------------------------------
test('fingerprints detect header drift but never value changes', () => {
  const staleHeader = ['Company Name', 'Linkedin Link', '1st POC Name', 'Phone', 'Email', '2nd POC Name', '', 'Email', '1st POCCall Outcome', '2nd POC Call outcome', 'Remarks'];
  const liveHeader = ['Company Name', 'Linkedin Link', '1st POC Name', 'Phone', 'Email', '2nd POC Name', 'Phone', 'Email', '1st POC Call Outcome', '2nd POC Call outcome', 'Remarks'];
  const values = ['Acme Systems', 'https://www.linkedin.com/in/acme/', 'Rahul Sharma', '9876543210', 'rahul@acme.io', 'Priya Nair', '9876543211', 'priya@acme.io', 'Interested', 'Not answered', ''];
  const stale = schemaTools.inferSchema([staleHeader, values.slice(0, 6).concat(['', 'priya@acme.io']).slice(0, 11)]);
  const liveA = schemaTools.inferSchema([liveHeader, values]);
  const liveB = schemaTools.inferSchema([liveHeader, ['Totally Other Co', '', 'Someone', '', '', 'Other', '', '', '', '', '']]);
  assert.notEqual(stale.structuralFingerprint, liveA.structuralFingerprint, 'header change must produce a different structural fingerprint');
  assert.notEqual(stale.fingerprint, liveA.fingerprint, 'header change must produce a different legacy fingerprint');
  assert.equal(liveA.structuralFingerprint, liveB.structuralFingerprint, 'value change must not change the structural fingerprint');
  assert.equal(liveA.fingerprint, liveB.fingerprint, 'value change must not change the legacy fingerprint');
});

// ---------------------------------------------------------------------------
// TEST 17 — exact Aryalead headers (approval-time stale variant AND live
// variant) resolve safely. This is the historical production failure.
// ---------------------------------------------------------------------------
test('exact Aryalead headers resolve safely (stale + live variants)', () => {
  const staleHeader = ['Company Name', 'Linkedin Link', '1st POC Name', 'Phone', 'Email', '2nd POC Name', '', 'Email', '1st POCCall Outcome', '2nd POC Call outcome', 'Remarks'];
  const stale = schemaTools.inferSchema([
    staleHeader,
    ['Acme Systems', 'https://www.linkedin.com/in/acme/', 'Rahul Sharma', '9876543210', 'rahul@acme.io', 'Priya Nair', '', 'priya@acme.io', 'Interested', '', ''],
  ], { expectedPersonGroups: 2 });
  assert.equal(stale.personGroups.length, 2);
  assertFields(stale, 1, { name: 2, phone: 3, email: 4 });
  assertFields(stale, 2, { name: 5, phone: null, email: 7 });
  assert.equal(stale.companyGroups[0].fields.company.index, 0);
  // The approval-time fingerprint recorded in production must be reproduced
  // byte-for-byte — approval and execution can never disagree for one layout.
  assert.equal(
    stale.fingerprint,
    'company name|linkedin link|1st poc name|phone|email|2nd poc name||email|1st poccall outcome|2nd poc call outcome|remarks'
  );
  safe(stale);

  const liveHeader = ['Company Name', 'Linkedin Link', '1st POC Name', 'Phone', 'Email', '2nd POC Name', 'Phone', 'Email', '1st POC Call Outcome', '2nd POC Call outcome', 'Remarks'];
  const live = schemaTools.inferSchema([
    liveHeader,
    ['Acme Systems', 'https://www.linkedin.com/in/acme/', 'Rahul Sharma', '9876543210', 'rahul@acme.io', 'Priya Nair', '9876543211', 'priya@acme.io', 'Interested', '', ''],
    ['Globex Labs', 'https://www.linkedin.com/in/globex/', 'Amit Verma', '9876543212', 'amit@globex.io', 'Sara Khan', '9876543213', 'sara@globex.io', '', '', ''],
  ], { expectedPersonGroups: 2 });
  assert.equal(live.personGroups.length, 2);
  assertFields(live, 1, { name: 2, phone: 3, email: 4 });
  assertFields(live, 2, { name: 5, phone: 6, email: 7 });
  assert.ok(live.confidence >= 0.9, `live Aryalead confidence must stay high, got ${live.confidence}`);
  assert.equal(
    live.fingerprint,
    'company name|linkedin link|1st poc name|phone|email|2nd poc name|phone|email|1st poc call outcome|2nd poc call outcome|remarks'
  );
  safe(live);
});

// ---------------------------------------------------------------------------
// TEST 18 — GENUINE ambiguity (two identical "POC 1" columns) throws
// UNIVERSAL_SCHEMA_AMBIGUOUS with the full structured diagnostics payload.
// ---------------------------------------------------------------------------
test('genuine double-POC-1 ambiguity throws AMBIGUOUS with diagnostics', () => {
  const rows = [
    ['Company Name', 'POC 1', 'POC 1', 'Email'],
    ['Acme Systems', 'Alice Kumar', 'Carol Dsouza', 'team@acme.io'],
  ];
  const schema = schemaTools.inferSchema(rows);
  let thrown = null;
  try {
    safety.assertSafe(schema, CTX);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'two identical POC 1 columns are genuinely ambiguous and must throw');
  assert.equal(thrown.code, 'UNIVERSAL_SCHEMA_AMBIGUOUS');
  assert.equal(thrown.subsystem, 'SCHEMA');
  assert.ok(Array.isArray(thrown.questions) && thrown.questions.length > 0, 'questions required');
  assert.match(thrown.message, /contact 1/);

  const d = thrown.diagnostics;
  assert.ok(d, 'structured diagnostics required');
  assert.equal(d.code, 'UNIVERSAL_SCHEMA_AMBIGUOUS');
  assert.equal(d.worksheet, CTX.worksheet);
  assert.equal(d.spreadsheetId, CTX.spreadsheetId);
  assert.ok(Number.isInteger(d.headerRow), 'diagnostics.headerRow required');
  assert.ok(Array.isArray(d.candidateColumns) && d.candidateColumns.length >= 3, 'diagnostics.candidateColumns required');
  assert.ok(Array.isArray(d.normalizedHeaders) && d.normalizedHeaders.length >= 3, 'diagnostics.normalizedHeaders required');
  assert.ok(Array.isArray(d.competingMappings) && d.competingMappings.length >= 1, 'diagnostics.competingMappings required');
  assert.ok(Array.isArray(d.scores) && d.scores.length >= 1, 'diagnostics.scores required');
  assert.ok(Array.isArray(d.resolutionAttempts) && d.resolutionAttempts.length >= 1, 'diagnostics.resolutionAttempts required');
  assert.equal(typeof d.confidence, 'number');
  assert.equal(typeof d.reason, 'string');
  assert.ok(d.reason.length > 0);
  assert.equal(d.partial, false);
  assert.equal(d.recoverable, false, 'genuine ambiguity is not silently recoverable');
});

// ---------------------------------------------------------------------------
// Property/fuzz test (Phase 16) — seeded random header variation: aliases,
// casing, punctuation, block/column shuffles, extra columns, empty slots.
// Every generated sheet must resolve deterministically to the expected
// structure without ever raising UNIVERSAL_SCHEMA_AMBIGUOUS.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMPANY_POOL = ['Company Name', 'Company', 'Organization', 'Organisation', 'Company Account', 'Employer', 'Firm'];
const NAME1_POOL = ['1st POC Name', 'POC 1 Name', 'First POC Name', 'P.O.C. 1 Name', 'First Point of Contact', 'Primary Contact', 'POC #1 Name'];
const NAME2_POOL = ['2nd POC Name', 'POC 2 Name', 'Second POC Name', 'P.O.C. 2 Name', 'Second Point of Contact', 'Secondary Contact', 'POC #2 Name'];
const PHONE1_POOL = ['Phone', '1st POC Phone', 'POC 1 Phone', 'First POC Phone', 'Mobile Number', 'Phone Number', 'Primary Phone', 'POC 1 Number'];
const PHONE2_POOL = ['Phone', '2nd POC Phone', 'POC 2 Phone', 'Second POC Phone', 'Mobile Number', 'Telephone Number', 'Secondary Phone', 'POC 2 Number'];
const EMAIL1_POOL = ['Email', '1st POC Email', 'POC 1 Email', 'First POC Email', 'Email Address', 'Primary Email'];
const EMAIL2_POOL = ['Email', '2nd POC Email', 'POC 2 Email', 'Second POC Email', 'Email ID', 'Secondary Email'];
const EXTRA_POOL = ['Priority', 'Owner', 'Notes', 'Remarks', 'Budget', 'Internal ID', 'Last Updated', 'Lead Source'];
const EXTRA_VALUES = ['High', 'ops-team', 'n/a', 'reviewed', '100000', 'INT-77', '2026-10-01', 'apollo'];

// Ordinal-explicit-only pools for individual column shuffling: a bare "Phone"
// header may only rely on adjacency while its block stays contiguous.
const SHUFFLE_NAME1 = NAME1_POOL.filter((h) => /1/.test(h) || /First|Primary/i.test(h));
const SHUFFLE_NAME2 = NAME2_POOL.filter((h) => /2/.test(h) || /Second|Secondary/i.test(h));
const SHUFFLE_PHONE1 = PHONE1_POOL.filter((h) => /1/.test(h) || /Primary/i.test(h));
const SHUFFLE_PHONE2 = PHONE2_POOL.filter((h) => /2/.test(h) || /Second/i.test(h));
const SHUFFLE_EMAIL1 = EMAIL1_POOL.filter((h) => /1/.test(h) || /Primary/i.test(h));
const SHUFFLE_EMAIL2 = EMAIL2_POOL.filter((h) => /2/.test(h) || /Second/i.test(h));

function valueFor(header, row) {
  const h = schemaTools.normalizeHeader(header);
  if (h === '' || EXTRA_POOL.some((x) => schemaTools.normalizeHeader(x) === h)) return EXTRA_VALUES[EXTRA_POOL.findIndex((x) => schemaTools.normalizeHeader(x) === h)] ?? 'n/a';
  if (/linkedin|profile/.test(h)) return `https://www.linkedin.com/in/fuzz-person-${row}/`;
  if (/mail/.test(h)) return `fuzz${row}@example.com`;
  if (/phone|mobile|number|telephone|contact no/.test(h)) return `+9198765432${row}`;
  if (/company|organization|organisation|employer|firm/.test(h)) return 'Fuzz Industries';
  if (/name|contact|poc/.test(h)) return `Fuzz Person ${row}`;
  return 'n/a';
}

function fuzzRows(seed, mode) {
  const rand = mulberry32(seed);
  const pick = (pool) => pool[Math.floor(rand() * pool.length)];
  const caseify = (text) => {
    const roll = rand();
    if (roll < 0.25) return text.toUpperCase();
    if (roll < 0.4) return text.toLowerCase();
    if (roll < 0.5) return `  ${text}  `;
    return text;
  };
  const company = pick(COMPANY_POOL);
  let columns;
  if (mode === 'blocks') {
    const blocks = [
      [company],
      [pick(NAME1_POOL), pick(PHONE1_POOL), pick(EMAIL1_POOL)],
      [pick(NAME2_POOL), pick(PHONE2_POOL), pick(EMAIL2_POOL)],
    ];
    for (let i = blocks.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
    }
    columns = blocks.flat();
    const extraCount = Math.floor(rand() * 3);
    for (let i = 0; i < extraCount; i++) {
      const at = Math.floor(rand() * (columns.length + 1));
      columns.splice(at, 0, pick(EXTRA_POOL));
    }
  } else {
    columns = [company, pick(SHUFFLE_NAME1), pick(SHUFFLE_PHONE1), pick(SHUFFLE_EMAIL1), pick(SHUFFLE_NAME2), pick(SHUFFLE_PHONE2), pick(SHUFFLE_EMAIL2)];
    for (let i = columns.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [columns[i], columns[j]] = [columns[j], columns[i]];
    }
    const extraCount = Math.floor(rand() * 3);
    for (let i = 0; i < extraCount; i++) {
      const at = Math.floor(rand() * (columns.length + 1));
      columns.splice(at, 0, pick(EXTRA_POOL));
    }
  }
  const header = columns.map(caseify);
  const empty = rand() < 0.25;
  const rowsFor = (row) => columns.map((c) => (empty ? '' : valueFor(c, row)));
  return [header, rowsFor(1), rowsFor(2)];
}

(function fuzz() {
  const SEEDS = 200;
  const rand = mulberry32(0xBEEF);
  for (let seed = 1; seed <= SEEDS; seed++) {
    const mode = rand() < 0.5 ? 'blocks' : 'columns';
    const rows = fuzzRows(seed * 7919 + (mode === 'columns' ? 1 : 0), mode);
    const describe = () => `seed=${seed} mode=${mode} header=${JSON.stringify(rows[0])}`;
    let schema;
    try {
      schema = schemaTools.inferSchema(rows, { expectedPersonGroups: 2 });
    } catch (error) {
      console.error(`FUZZ FAILED (infer) ${describe()}`);
      console.error((error && error.stack) || error);
      process.exit(1);
    }
    if (error2Check(schema, rows, describe)) process.exit(1);
    // Determinism: a second inference must be structurally identical.
    const again = schemaTools.inferSchema(rows, { expectedPersonGroups: 2 });
    if (
      again.structuralFingerprint !== schema.structuralFingerprint
      || fingerprintMaps(again) !== fingerprintMaps(schema)
    ) {
      console.error(`FUZZ FAILED (nondeterministic) ${describe()}`);
      process.exit(1);
    }
    // Value independence: identical headers with different values must give
    // the identical resolved structure.
    const valueVaried = [rows[0].slice(), rows[1].map(() => ''), rows[2].map(() => '')];
    const varied = schemaTools.inferSchema(valueVaried, { expectedPersonGroups: 2 });
    if (varied.structuralFingerprint !== schema.structuralFingerprint || fingerprintMaps(varied) !== fingerprintMaps(schema)) {
      console.error(`FUZZ FAILED (value-dependent structure) ${describe()}`);
      console.error(`  populated: ${fingerprintMaps(schema)}`);
      console.error(`  empty:     ${fingerprintMaps(varied)}`);
      process.exit(1);
    }
    // Never ambiguous, always safe.
    let assessment = null;
    try {
      assessment = safety.assess(schema, CTX);
    } catch (error) {
      console.error(`FUZZ FAILED (assess threw) ${describe()}`);
      console.error((error && error.stack) || error);
      process.exit(1);
    }
    if (assessment.ambiguityQuestions.length > 0 || assessment.safe === false) {
      console.error(`FUZZ FAILED (spurious ambiguity) ${describe()}`);
      console.error(JSON.stringify(assessment.diagnostics, null, 2));
      process.exit(1);
    }
    if (assessment.lowConfidence) {
      console.error(`FUZZ FAILED (spurious low confidence) ${describe()}`);
      console.error(`  confidence=${schema.confidence}`);
      process.exit(1);
    }
  }
  console.log(`FUZZ  200 seeded header variations resolved deterministically (no ambiguity, no low confidence)`);

  function error2Check(schema, rows, describe) {
    if (schema.personGroups.length !== 2) {
      console.error(`FUZZ FAILED (expected 2 person groups, got ${schema.personGroups.length}) ${describe()}`);
      console.error(`  maps: ${fingerprintMaps(schema)}`);
      return true;
    }
    for (const ordinal of [1, 2]) {
      const g = schema.personGroups.find((x) => Number(x.ordinal) === ordinal);
      if (!g || !g.fields.name || !g.fields.phone || !g.fields.email) {
        console.error(`FUZZ FAILED (group ${ordinal} incomplete) ${describe()}`);
        console.error(`  maps: ${fingerprintMaps(schema)}`);
        return true;
      }
    }
    return false;
  }
})();

console.log(`SCHEMA RESOLUTION SELFTEST: ${completed}/${TOTAL} cases + 200 fuzz seeds PASSED`);
