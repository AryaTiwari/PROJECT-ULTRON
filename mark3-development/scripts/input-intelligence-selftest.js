#!/usr/bin/env node
const assert = require('assert');
const input = require('../core/input-intelligence');

assert.equal(input.classify('enrich this spreadsheet with Apollo'), 'lead-enrichment');
assert.equal(input.classify('make a reel for Elevate OS'), 'artifact-generation');
assert.equal(input.classify('fix this GitHub repo'), 'coding');
assert.equal(input.isVague('do it'), true);
assert.equal(input.isVague('same for this'), true);
assert.equal(input.isVague('make it longer'), false);

const direct = input.resolve('Ultron, fill this spreadsheet with Apollo: https://docs.google.com/spreadsheets/d/new-sheet/edit');
assert.equal(direct.intent, 'lead-enrichment');
assert.equal(direct.resolvedMessage, 'Ultron, enrich this sheet with Apollo: https://docs.google.com/spreadsheets/d/new-sheet/edit');
assert.equal(direct.clarification, null);

const history = [
  { role: 'user', content: 'Ultron, enrich this sheet with Apollo: https://docs.google.com/spreadsheets/d/old-sheet/edit', taskType: 'lead-enrichment' },
  { role: 'assistant', content: 'Done, Sir.' },
];
const similar = input.resolve('@Tomorrow Leads', { history });
assert.equal(similar.intent, 'lead-enrichment');
assert.equal(similar.resolvedMessage, 'Ultron, enrich this sheet with Apollo: @Tomorrow Leads');
assert.equal(similar.autoResolved, true);
assert.equal(similar.clarification, null);

const riskyHistory = [
  { role: 'user', content: 'Deploy the mark3-development branch to production', taskType: 'coding' },
  { role: 'assistant', content: 'The deployment is ready for approval.' },
];
const risky = input.resolve('do it', { history: riskyHistory });
assert.equal(risky.autoResolved, false);
assert.ok(risky.clarification);

console.log('Input Intelligence self-test passed. Easy commands, previous-command matching, explicit Apollo shortcuts and risky vague-action clarification are healthy.');
