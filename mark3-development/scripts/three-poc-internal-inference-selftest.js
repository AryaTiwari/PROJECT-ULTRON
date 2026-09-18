const assert = require('assert/strict');

// This script is already part of npm start/check. Load the universal deterministic,
// typed-error, Apollo-transport, Google core-API, routing, approval, Google-values
// range hardening, contact-display, ordinal-contact, orphan-contact, exact Arya 2
// layout and bounded Big Pickle fallback regressions here so enrichment cannot
// regress silently.
require('./spreadsheet-error-taxonomy-selftest');
require('./apollo-fetch-hardening-selftest');
require('./google-sheets-core-api-selftest');
require('./google-sheets-values-range-hardening-selftest');
require('./universal-deterministic-enrichment-selftest');
require('./universal-partial-safe-execution-selftest');
require('./universal-ai-batch-rescue-selftest');
require('./universal-spreadsheet-routing-selftest');
require('./universal-approval-routing-selftest');
require('./universal-contact-display-selftest');
require('./universal-ordinal-contact-selftest');
require('./universal-orphan-contact-selftest');
require('./three-poc-arya2-layout-selftest');
require('./three-poc-big-pickle-selftest');

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
  await require('./universal-contact-completion-selftest').run();
  await require('./universal-schema-continuity-selftest').run();
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

  await control.runInternalInference('spreadsheet-enrichment', async () => {
    assert.doesNotThrow(() => control.assertAllowed('general-model', {
      messages: [{ role: 'user', content: internalPayload }],
    }));
    assert.doesNotThrow(() => control.assertAllowed('direct-model', {
      model: 'xai/grok-4.6',
      messages: [{ role: 'user', content: internalPayload }],
    }));
    assert.throws(
      () => control.assertAllowed('omniroute'),
      (error) => error && error.code === 'SPREADSHEET_ENRICHMENT_ROUTE_INVARIANT_VIOLATION'
    );
  });

  console.log('3-POC internal inference self-test passed. Universal deterministic spreadsheet, typed-error taxonomy, Apollo transport retry, verified contact completion, schema continuity recovery, bounded direct-env AI batch rescue, Google core-API and values-range hardening, routing, approval, contact-display, ordinal-contact, orphan-contact, exact Arya 2 layout and bounded Big Pickle fallback regressions also ran; direct env-backed models are permitted only inside authorized spreadsheet inference, while OmniRoute remains blocked there.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});