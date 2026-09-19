'use strict';

const assert = require('assert/strict');

const operator = require('../core/universal-sheet-enrichment-operator');
const leadSources = require('../core/lead-source-fusion');
const web = require('../core/web');
const apollo = require('../core/apollo-enrichment');

const originalLeadStatus = leadSources.status;
const originalSerpSearch = leadSources.serpSearch;
const originalWebStatus = web.status;
const originalWebSearch = web.searchWeb;
const originalResolvePersonProfile = apollo.resolvePersonProfile;

const COMPANY = 'Hanvitt Consulting & Solutions';
const LINKEDIN = 'https://www.linkedin.com/in/jane-hanvitt-test';

function publicResult(url = LINKEDIN) {
  return {
    title: 'Jane Example - Talent Acquisition Manager - Hanvitt Consulting & Solutions | LinkedIn',
    snippet: 'Talent acquisition and hiring at Hanvitt Consulting & Solutions.',
    url,
  };
}

async function runSerpCase() {
  const stats = operator.freshStats();
  let serpCalls = 0;
  let tinyfishCalls = 0;

  leadSources.status = () => ({ serpApiConfigured: true });
  leadSources.serpSearch = async () => {
    serpCalls++;
    return { results: [publicResult()], provider: 'serpapi-google' };
  };
  web.status = () => ({ configured: true });
  web.searchWeb = async () => {
    tinyfishCalls++;
    return { results: [] };
  };
  apollo.resolvePersonProfile = async (linkedinUrl) => ({
    ok: true,
    identityVerified: true,
    apolloPersonId: 'apollo-jane-1',
    name: 'Jane Example',
    title: 'Talent Acquisition Manager',
    headline: 'Hiring at Hanvitt Consulting & Solutions',
    linkedinUrl,
    organizationName: COMPANY,
    organizationDomain: '',
  });

  const people = await operator.discoverPublicIndexPeople(
    { company: COMPANY, domain: '' },
    stats,
    { publicIndexVerifyLimit: 8 }
  );

  assert.equal(people.length, 1, 'SerpApi public-index candidate should survive exact Apollo employer verification.');
  assert.equal(people[0].publicIndexApolloVerified, true);
  assert.equal(people[0].organizationName, COMPANY);
  assert.ok(serpCalls >= 1);
  assert.equal(tinyfishCalls, 0, 'TinyFish should be fallback-only when SerpApi already yields profile refs.');
  assert.ok(stats.publicIndexProfilesFound >= 1);
  assert.equal(stats.publicIndexApolloVerifiedCandidates, 1);
}

async function runTinyFishCase() {
  const stats = operator.freshStats();
  let tinyfishCalls = 0;

  leadSources.status = () => ({ serpApiConfigured: false });
  leadSources.serpSearch = async () => {
    throw new Error('SerpApi must not run when it is not configured.');
  };
  web.status = () => ({ configured: true });
  web.searchWeb = async () => {
    tinyfishCalls++;
    return { results: [publicResult('https://www.linkedin.com/in/jane-hanvitt-tinyfish')] };
  };
  apollo.resolvePersonProfile = async (linkedinUrl) => ({
    ok: true,
    identityVerified: true,
    apolloPersonId: 'apollo-jane-2',
    name: 'Jane Example',
    title: 'HR Manager',
    headline: 'Human Resources at Hanvitt Consulting & Solutions',
    linkedinUrl,
    organizationName: COMPANY,
    organizationDomain: '',
  });

  const people = await operator.discoverPublicIndexPeople(
    { company: COMPANY, domain: '' },
    stats,
    { publicIndexVerifyLimit: 8 }
  );

  assert.equal(people.length, 1, 'TinyFish public-index candidate should survive exact Apollo employer verification.');
  assert.equal(people[0].publicIndexApolloVerified, true);
  assert.ok(tinyfishCalls >= 1);
  assert.equal(stats.publicIndexApolloVerifiedCandidates, 1);
}

async function runMismatchCase() {
  const stats = operator.freshStats();

  leadSources.status = () => ({ serpApiConfigured: true });
  leadSources.serpSearch = async () => ({ results: [publicResult()] });
  web.status = () => ({ configured: false });
  apollo.resolvePersonProfile = async (linkedinUrl) => ({
    ok: true,
    identityVerified: true,
    apolloPersonId: 'apollo-wrong-company',
    name: 'Wrong Company Person',
    title: 'Recruiter',
    linkedinUrl,
    organizationName: 'Completely Different Employer',
    organizationDomain: '',
  });

  const people = await operator.discoverPublicIndexPeople(
    { company: COMPANY, domain: '' },
    stats,
    { publicIndexVerifyLimit: 8 }
  );

  assert.equal(people.length, 0, 'Public-index discovery must never write a person whose Apollo employer does not match the row employer.');
}

(async () => {
  try {
    assert.ok(operator.publicIndexQueries({ company: COMPANY }).every((query) => /site:linkedin\.com\/in/i.test(query)));
    await runSerpCase();
    await runTinyFishCase();
    await runMismatchCase();
    console.log('Universal public-index fallback self-test passed: SerpApi and TinyFish can supply LinkedIn person refs, Apollo remains the exact identity/employer authority, and mismatched employers are rejected.');
  } finally {
    leadSources.status = originalLeadStatus;
    leadSources.serpSearch = originalSerpSearch;
    web.status = originalWebStatus;
    web.searchWeb = originalWebSearch;
    apollo.resolvePersonProfile = originalResolvePersonProfile;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
