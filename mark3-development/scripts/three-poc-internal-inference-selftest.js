const assert = require('assert/strict');

// This script is already part of npm start/check. Load the universal deterministic,
// routing, approval, contact-display, ordinal-contact and orphan-contact regression
// suites here so arbitrary-layout enrichment cannot regress silently.
require('./universal-deterministic-enrichment-selftest');
require('./universal-spreadsheet-routing-selftest');
require('./universal-approval-routing-selftest');
require('./universal-contact-display-selftest');
require('./universal-ordinal-contact-selftest');
require('./universal-orphan-contact-selftest');

const control = require('../core/command-control-plane');

const internalPayload = JSON.stringify({
  company: 'Example Staffing',
  hiringContext: 'Hiring SAP consultant. Send resume to recruiter@example.com',
  anchorPerson: {
    name: 'Anchor Recruiter',
    linkedinUrl: 'https://www.linkedin.com/in/anchor-recruiter/',
  },
  candidates: [
    { candidateKey: 'c1', name: 'A***', title: 'Talent Acquisition Lead' },
    { candidateKey: 'c2', name: 'B***', title: 'Technical Recruiter' },
  ],
});

assert.equal(control.isInternalModelPayload(internalPayload), true);
assert.equal(control.isInternalModelPayload('Find recruiter email from LinkedIn'), false);
assert.equal(control.invariantCodeForDomain('linkedin'), 'LINKEDIN_ROUTE_INVARIANT_VIOLATION');
assert.equal(control.invariantCodeForDomain('three-poc-spreadsheet'), 'THREE_POC_ROUTE_INVARIANT_VIOLATION');

// Historical regression: internal JSON containing linkedin.com + email must not
// be reclassified as a fresh external LinkedIn user command.
assert.doesNotThrow(() => control.assertAllowed('general-model', {
  messages: [{ role: 'user', content: internalPayload }],
}));

assert.throws(
  () => control.assertAllowed('general-model', {
    messages: [{ role: 'user', content: 'Find the email for this person on LinkedIn and enrich the contact.' }],
  }),
  (error) => error && error.code === 'LINKEDIN_ROUTE_INVARIANT_VIOLATION'
);

(async () => {
  await control.runInternalInference('three-poc-spreadsheet', async () => {
    assert.doesNotThrow(() => control.assertAllowed('general-model', {
      messages: [{ role: 'user', content: internalPayload }],
    }));
    assert.throws(
      () => control.assertAllowed('direct-model', {
        model: 'gemini/gemini-3.6-flash',
        messages: [{ role: 'user', content: internalPayload }],
      }),
      (error) => error && error.code === 'THREE_POC_ROUTE_INVARIANT_VIOLATION'
    );
  });

  console.log('3-POC internal inference self-test passed. Universal deterministic spreadsheet, routing, approval, contact-display, ordinal-contact and orphan-contact regressions also ran; legacy scoped OmniRoute fallback remains isolated and direct personal-model calls stay blocked.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
