#!/usr/bin/env node
const assert = require('assert');
const repair = require('../core/lead-enrichment-null-phone-repair');

const fakeAdapter = {
  isBlank(value) {
    return value === '' || value === null || value === undefined || String(value).trim().toLowerCase() === 'null';
  },
};

assert.equal(repair.isNullSentinel('null'), true);
assert.equal(repair.isNullSentinel(' NULL '), true);
assert.equal(repair.isNullSentinel('+919999999999'), false);
assert.equal(repair.phoneCellNeedsLocalRepair('null', fakeAdapter), true);
assert.equal(repair.phoneCellNeedsLocalRepair('', fakeAdapter), true);
assert.equal(repair.phoneCellNeedsLocalRepair('+919999999999', fakeAdapter), false);

assert.equal(repair.contentHeaderScore('Post Details') >= 90, true);
assert.equal(repair.contentHeaderScore('Job Description') >= 90, true);
assert.equal(repair.contentHeaderScore('Recruiter Post Content') >= 90, true);
assert.equal(repair.contentHeaderScore('PHONE'), 0);
assert.equal(repair.contentHeaderScore('LinkedIn ID'), 0);

const standardRows = [
  ['Person', 'L', 'Post Details', 'L', 'Linkedin Id', 'PHONE', 'EMAIL'],
  ['Srushti More', 'L', 'Interested candidates can share CV / DM me on -9684020880', '', 'ID: https://www.linkedin.com/in/srushti-more/', 'null', 'someone@example.com'],
];
const standardLayout = { headerRowIndex: 0, phoneColumnIndex: 5, emailColumnIndex: 6, linkedinColumnIndex: 4 };
assert.deepEqual(repair.inferredContentColumns(standardRows, standardLayout), [2]);
assert.equal(repair.localPhoneCandidate(standardRows[1], standardLayout, [2]), '+919684020880');

const shuffledRows = [
  ['Work Email', 'Recruiter Name', 'Job Description', 'Mobile No', 'LinkedIn Profile'],
  ['a@example.com', 'Aarti', 'Send your CV. Phone: 98716 38699', 'null', 'https://www.linkedin.com/in/aarti/'],
];
const shuffledLayout = { headerRowIndex: 0, phoneColumnIndex: 3, emailColumnIndex: 0, linkedinColumnIndex: 4 };
assert.deepEqual(repair.inferredContentColumns(shuffledRows, shuffledLayout), [2]);
assert.equal(repair.localPhoneCandidate(shuffledRows[1], shuffledLayout, [2]), '+919871638699');

const renamedRows = [
  ['Candidate', 'Requirement Details', 'Contact Number', 'Profile URL', 'Mail'],
  ['Mahesh', 'Third-party vendors welcome. Contact me only through WhatsApp: 9885906146.', 'null', 'https://www.linkedin.com/in/mahesh/', 'm@example.com'],
];
const renamedLayout = { headerRowIndex: 0, phoneColumnIndex: 2, emailColumnIndex: 4, linkedinColumnIndex: 3 };
assert.deepEqual(repair.inferredContentColumns(renamedRows, renamedLayout), [1]);
assert.equal(repair.localPhoneCandidate(renamedRows[1], renamedLayout, [1]), '+919885906146');

const textHeavyRows = [
  ['Name', 'Data', 'Phone', 'LinkedIn'],
  ['One', 'This is a long recruitment post without a useful header name. Candidates can apply and share CV on 9985921112. '.repeat(2), 'null', 'https://www.linkedin.com/in/one/'],
  ['Two', 'Another detailed recruitment post with many words and line breaks.\nPlease contact our hiring team at 9876543210 for this role. '.repeat(2), 'null', 'https://www.linkedin.com/in/two/'],
  ['Three', 'A third long body of recruitment copy that makes this column obviously content rather than an ID or metric field. '.repeat(2), 'null', 'https://www.linkedin.com/in/three/'],
];
const textHeavyLayout = { headerRowIndex: 0, phoneColumnIndex: 2, emailColumnIndex: -1, linkedinColumnIndex: 3 };
assert.equal(repair.inferredContentColumns(textHeavyRows, textHeavyLayout).includes(1), true);
assert.equal(repair.localPhoneCandidate(textHeavyRows[1], textHeavyLayout, [1]), '+919985921112');

assert.equal(
  repair.localPhoneCandidate([
    'Ashish Sharma',
    'L',
    'Contact: #8448712209\nEmail: ashish@example.com',
    '',
    'ID: https://www.linkedin.com/in/ashish/',
    'null',
    'ashish@example.com',
  ], standardLayout, [2]),
  '+918448712209'
);

assert.equal(
  repair.localPhoneCandidate([
    'No phone',
    'L',
    'Salary: 9876543210\nJob ID: 9123456789',
    '',
    'ID: https://www.linkedin.com/in/no-phone/',
    'null',
    'x@example.com',
  ], standardLayout, [2]),
  null
);

assert.equal(
  repair.phoneCandidateFromText('For support call +1 703 349 2737 ext 710', { isContentColumn: true }).phone,
  '+17033492737ext710'
);

assert.equal(
  repair.phoneCandidateFromText('Req ID: 9876543210', { isContentColumn: true }),
  null
);

console.log('Null-phone repair self-test passed. Dynamic post/details-column detection, shuffled spreadsheet layouts, text-heavy fallback, null replacement, phone normalization and false-positive blocking are healthy without Apollo calls.');
