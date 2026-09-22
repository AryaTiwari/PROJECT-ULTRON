#!/usr/bin/env node
const assert = require('assert/strict');
const direct = require('../core/direct-provider-router');
const compiler = require('../core/linkedin-request-compiler');

assert.equal(compiler.shouldCompile('Find SAP companies'), true);
assert.equal(compiler.shouldCompile('Could you look through LinkedIn for SAP companies in Maharashtra?'), true);

const normalized = compiler.normalizedIR({
  entityMode: 'company',
  targetMode: 'master_total',
  targetValue: 30,
  topic: 'SAP',
  hiringRequired: true,
  locationScope: 'job',
  allowedLocations: ['Maharashtra', 'Bangalore', 'Maharashtra'],
  preferredLocations: ['Maharashtra', 'Bangalore'],
  employeeMin: null,
  employeeMax: 1000,
  workType: 'remote',
  workTypeStrictness: 'preference',
  jobType: null,
  experienceLevel: null,
  datePosted: null,
  easyApply: false,
  useFinalMaster: true,
  resumeExistingPool: true,
  reuseCachedEvidence: true,
  wantsContacts: false,
  linkedinOnly: true,
});
assert.equal(normalized.ok, true);
assert.deepEqual(normalized.value.allowedLocations, ['Maharashtra', 'Bengaluru']);
assert.equal(normalized.value.workTypeStrictness, 'preference');

const canonical = compiler.canonicalPrompt(normalized.value);
assert.match(canonical, /reach exactly 30 verified companies total/i);
assert.match(canonical, /active SAP job opening/i);
assert.match(canonical, /Allowed job locations only: Maharashtra, Bengaluru/i);
assert.match(canonical, /Maximum 1000 employees/i);
assert.match(canonical, /Prefer remote; it is a preference only, not mandatory/i);
assert.match(canonical, /Reuse saved discovery, cached evidence/i);
assert.match(canonical, /Do not use Apollo/i);

const oldGemini = process.env.GEMINI_API_KEY;
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'selftest-placeholder';
const originalChat = direct.chat;
direct.chat = async ({ model, tools }) => {
  assert.match(model, /^gemini\//i);
  assert.equal(tools.length, 1);
  return {
    model,
    provider: 'gemini',
    toolCalls: [{
      id: 'compile-1',
      type: 'function',
      function: {
        name: 'compile_linkedin_request',
        arguments: JSON.stringify(normalized.value),
      },
    }],
  };
};

(async () => {
  try {
    const result = await compiler.compile('Please trawl LinkedIn and build my verified SAP-company master to 30, Maharashtra first and Bangalore second, remote ideally.');
    assert.equal(result.ok, true);
    assert.equal(result.ir.targetMode, 'master_total');
    assert.equal(result.ir.targetValue, 30);
    assert.equal(result.provider, 'gemini');
    assert.match(result.canonicalPrompt, /LinkedIn only/i);
    console.log('LinkedIn request compiler passed: typed mission IR, runtime validation, canonical prompt generation, and Gemini-only bounded rescue path.');
  } finally {
    direct.chat = originalChat;
    if (oldGemini == null) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldGemini;
  }
})().catch((error) => {
  direct.chat = originalChat;
  if (oldGemini == null) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = oldGemini;
  console.error(error);
  process.exitCode = 1;
});
