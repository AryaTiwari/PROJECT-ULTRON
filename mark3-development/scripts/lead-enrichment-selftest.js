#!/usr/bin/env node
const assert = require('assert');
const sheets = require('../core/google-sheets-operator');
const apollo = require('../core/apollo-enrichment');
const bootstrap = require('../core/lead-enrichment-bootstrap');

const rows = [
  ['Office lead list', '', '', '', ''],
  ['', '', '', '', ''],
  ['Name', 'Company', 'LinkedIn Profile URL', 'Email Address', 'Mobile Number'],
  ['A', 'Acme', 'https://www.linkedin.com/in/person-one?trk=test', '', ''],
  ['B', 'Beta', 'linkedin.com/in/person-two/', '', ''],
];

const layout = sheets.detectLayout(rows);
assert.equal(layout.headerRowNumber, 3);
assert.equal(layout.linkedinColumn, 'C');
assert.equal(layout.emailColumn, 'D');
assert.equal(layout.phoneColumn, 'E');
assert.equal(sheets.columnName(0), 'A');
assert.equal(sheets.columnName(25), 'Z');
assert.equal(sheets.columnName(26), 'AA');
assert.equal(apollo.normalizeLinkedIn('https://www.linkedin.com/in/person-one/?trk=abc'), 'https://www.linkedin.com/in/person-one');
assert.equal(apollo.normalizeLinkedIn('linkedin.com/in/person-two/'), 'https://www.linkedin.com/in/person-two');
assert.equal(apollo.normalizeLinkedIn('https://www.linkedin.com/company/acme'), null);
assert.equal(sheets.hyperlinkFromCell({ hyperlink: 'https://www.linkedin.com/in/hidden-target' }), 'https://www.linkedin.com/in/hidden-target');
assert.equal(sheets.hyperlinkFromCell({ userEnteredValue: { formulaValue: '=HYPERLINK("https://www.linkedin.com/in/formula-target","LinkedIn")' } }), 'https://www.linkedin.com/in/formula-target');
assert.equal(sheets.hyperlinkFromCell({ textFormatRuns: [{ format: { link: { uri: 'https://www.linkedin.com/in/rich-target' } } }] }), 'https://www.linkedin.com/in/rich-target');
assert.equal(sheets.isBlank('null'), true);
assert.equal(sheets.isBlank(' NULL '), true);
assert.equal(sheets.isBlank('real@email.com'), false);

const exact = apollo.matchDecision('https://www.linkedin.com/in/person-one', {
  match_confidence: 'high',
  person: { id: 'p1', linkedin_url: 'https://www.linkedin.com/in/person-one/' },
});
assert.equal(exact.state, 'accepted');

const canonicalHigh = apollo.matchDecision('https://www.linkedin.com/in/old-person-slug', {
  match_confidence: 'high',
  person: { id: 'p2', linkedin_url: 'https://www.linkedin.com/in/current-person-slug' },
});
assert.equal(canonicalHigh.state, 'accepted');

const canonicalMedium = apollo.matchDecision('https://www.linkedin.com/in/old-person-slug', {
  match_confidence: 'medium',
  person: { id: 'p3', linkedin_url: 'https://www.linkedin.com/in/current-person-slug' },
});
assert.equal(canonicalMedium.state, 'accepted');

const canonicalNoConfidence = apollo.matchDecision('https://www.linkedin.com/in/old-person-slug', {
  person: { id: 'p4', linkedin_url: 'https://www.linkedin.com/in/current-person-slug' },
});
assert.equal(canonicalNoConfidence.state, 'accepted');

const ambiguousLow = apollo.matchDecision('https://www.linkedin.com/in/person-one', {
  match_confidence: 'low',
  person: { id: 'p5', linkedin_url: 'https://www.linkedin.com/in/someone-else' },
});
assert.equal(ambiguousLow.state, 'ambiguous');

const none = apollo.matchDecision('https://www.linkedin.com/in/person-one', { match_confidence: 'none', person: null });
assert.equal(none.state, 'no_match');

const validCommand = bootstrap.isEnrichmentRequest('Ultron, enrich this sheet with Apollo: https://docs.google.com/spreadsheets/d/abc123/edit#gid=0');
assert.ok(validCommand);
assert.equal(validCommand.invalidUrl, false);
assert.equal(validCommand.url, 'https://docs.google.com/spreadsheets/d/abc123/edit#gid=0');

const malformedCommand = bootstrap.isEnrichmentRequest('Ultron, enrich this sheet with Apollo: https://docs.google.com/spreadsheets/d/...');
assert.ok(malformedCommand);
assert.equal(malformedCommand.invalidUrl, true);
assert.equal(malformedCommand.url, null);
assert.equal(bootstrap.hasEnrichmentIntent('Ultron, enrich this sheet with Apollo: https://docs.google.com/spreadsheets/d/...'), true);

assert.ok(bootstrap.isStatusRequest('Apollo enrichment status'));
assert.ok(bootstrap.isResumeRequest('resume Apollo enrichment'));

const inferred = sheets.detectLayout([
  ['Lead', 'Email', 'Phone', 'Profile'],
  ['1', '', '', 'https://www.linkedin.com/in/alpha'],
  ['2', '', '', 'https://www.linkedin.com/in/beta'],
]);
assert.equal(inferred.headerRowNumber, 1);
assert.equal(inferred.linkedinColumn, 'D');
assert.equal(inferred.emailColumn, 'B');
assert.equal(inferred.phoneColumn, 'C');

console.log('Lead enrichment self-test passed. Embedded LinkedIn hyperlinks, null repair, Apollo standard-response matching and natural command routing are healthy.');
