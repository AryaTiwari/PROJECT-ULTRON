const assert = require('assert/strict');
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

// The exact bug: internal JSON contains linkedin.com + email, which the old
// fallback classifier treated as a fresh exclusive LinkedIn user command.
assert.doesNotThrow(() => control.assertAllowed('general-model', {
  messages: [{ role: 'user', content: internalPayload }],
}));

// Natural user commands must still be protected when they reach the fallback
// classifier outside the normal HTTP ownership path. Preserve the historical
// LinkedIn-specific error code because existing callers/tests rely on it.
assert.throws(
  () => control.assertAllowed('general-model', {
    messages: [{ role: 'user', content: 'Find the email for this person on LinkedIn and enrich the contact.' }],
  }),
  (error) => error && error.code === 'LINKEDIN_ROUTE_INVARIANT_VIOLATION'
);

// A domain-scoped internal reasoning permit may use the general-model boundary
// (OmniRoute), but must NOT unlock direct provider calls/personal API keys.
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

  console.log('3-POC internal inference self-test passed. Internal JSON is not reclassified as a LinkedIn user command; scoped OmniRoute reasoning remains allowed while direct personal-model calls remain blocked, with stable domain-specific invariant codes.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
