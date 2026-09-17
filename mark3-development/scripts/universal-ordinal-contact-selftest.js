'use strict';

const assert = require('assert/strict');
require('../core/universal-deterministic-bootstrap').install();
const schemaTools = require('../core/universal-sheet-schema');

// Mirrors the important structural feature of Arya 2 / Gaurav 2: the third
// identity header says only "3rd POC", while its phone/email fields follow it.
const rows = [
  [
    'Person or Company Name', 'L', 'Post Details', 'L', 'Linkedin Id', 'Phone no', 'Email ID',
    '2nd POC Name', 'Phone no', 'Email ID', '3rd POC', 'Phone no', 'Email ID', 'Call Outcome',
  ],
  [
    'Anchor One', '', 'Hiring SAP consultants', '', 'https://www.linkedin.com/in/anchor-one/', '+919000000001', 'anchor1@example.com',
    'Second Person', '+919000000002', 'second@example.com', '', '', '', '',
  ],
  [
    'Anchor Two', '', 'Hiring engineers', '', 'https://www.linkedin.com/in/anchor-two/', '+919000000011', 'anchor2@example.com',
    '', '', '', 'Third Person', '+919000000013', 'third@example.com', '',
  ],
];

const schema = schemaTools.inferSchema(rows);
assert.ok(schema.personGroups.length >= 3, `expected at least 3 person groups, got ${schema.personGroups.length}`);

const second = schema.personGroups.find((group) => Number(group.ordinal) === 2);
const third = schema.personGroups.find((group) => Number(group.ordinal) === 3);
assert.ok(second, '2nd POC group must exist');
assert.ok(third, '3rd POC group must be recovered even without the word Name');
assert.equal(third.fields.name?.index, 10, '3rd POC identity must map to column K/index 10');
assert.equal(third.fields.phone?.index, 11, '3rd POC phone must map to column L/index 11');
assert.equal(third.fields.email?.index, 12, '3rd POC email must map to column M/index 12');
assert.ok((schema.ordinalContactRecoveries || []).some((item) => item.ordinal === 3), 'ordinal recovery audit must record the third group');

// Generality: entity+ordinal can recover later contact groups without relying on POC wording.
const generalRows = [
  ['Company', 'Contact 1 Name', 'Contact 1 Email', 'Contact 4', 'Email 4', 'Mobile 4'],
  ['Example Co', 'Known Person', 'known@example.com', '', '', ''],
  ['Other Co', 'Other Person', 'other@example.com', 'Fourth Person', 'fourth@example.com', '+919999999999'],
];
const general = schemaTools.inferSchema(generalRows);
const fourth = general.personGroups.find((group) => Number(group.ordinal) === 4);
assert.ok(fourth, 'Contact 4 must recover a fourth person group');
assert.equal(fourth.fields.name?.index, 3);
assert.equal(fourth.fields.email?.index, 4);
assert.equal(fourth.fields.phone?.index, 5);

// Field headers carrying ordinals must never become fake identities.
assert.notEqual(third.fields.name?.header, 'Phone no');
assert.notEqual(fourth.fields.name?.header, 'Email 4');

console.log('Universal ordinal-contact self-test passed: entity+ordinal headers such as 3rd POC and Contact 4 create real contact groups without mistaking phone/email fields for identities.');
