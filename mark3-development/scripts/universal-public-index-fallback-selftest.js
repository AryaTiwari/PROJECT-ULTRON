'use strict';

const assert = require('assert/strict');

const operator = require('../core/universal-sheet-enrichment-operator');
const leadSources = require('../core/lead-source-fusion');
const web = require('../core/web');
const apollo = require('../core/apollo-enrichment');
const directSearch = require('../core/direct-web-search');

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
    { publicIndexVerifyLimit: 8, serpApiFallback: true }
  );

  assert.equal(people.length, 1, 'SerpApi public-index candidate should survive exact Apollo employer verification.');
  assert.equal(people[0].publicIndexApolloVerified, true);
  assert.equal(people[0].organizationName, COMPANY);
  assert.ok(serpCalls >= 1);
  assert.ok(tinyfishCalls >= 1, 'Keyless direct search must run before opt-in SerpApi fallback.');
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

async function runExistingRepairCase() {
  const stats = operator.freshStats();

  leadSources.status = () => ({ serpApiConfigured: true });
  leadSources.serpSearch = async () => ({
    results: [{
      title: 'Jane Example - Talent Acquisition Manager - Hanvitt Consulting & Solutions | LinkedIn',
      snippet: 'Jane Example works in talent acquisition at Hanvitt Consulting & Solutions.',
      url: LINKEDIN,
    }],
  });
  web.status = () => ({ configured: false });
  apollo.resolvePersonProfile = async (linkedinUrl) => ({
    ok: true,
    identityVerified: true,
    apolloPersonId: 'apollo-existing-jane',
    name: 'Jane Example',
    title: 'Talent Acquisition Manager',
    linkedinUrl,
    organizationName: COMPANY,
    organizationDomain: '',
    email: 'jane@example-hanvitt.invalid',
    phone: null,
  });

  const person = await operator.repairExistingContactFromPublicIndex({
    group: {
      id: 'poc2',
      ordinal: 2,
      fields: {
        name: { index: 1 },
        linkedin: { index: 2 },
        email: { index: 3 },
        phone: { index: 4 },
      },
    },
    snapshot: {
      hasIdentity: true,
      values: {
        name: 'Jane Example — Talent Acquisition Manager',
        linkedin: '',
        email: '',
        phone: '',
      },
    },
  }, { company: COMPANY, domain: '' }, stats, { serpApiFallback: true });

  assert.ok(person, 'existing named contact should be recoverable through exact-name public index + Apollo verification');
  assert.equal(person.apolloPersonId, 'apollo-existing-jane');
  assert.ok(stats.existingPublicIndexSearches >= 1);
  assert.equal(stats.existingPublicIndexVerified, 1);
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
    { publicIndexVerifyLimit: 8, serpApiFallback: true }
  );

  assert.equal(people.length, 0, 'Public-index discovery must never write a person whose Apollo employer does not match the row employer.');
}

(async () => {
  try {
    assert.ok(operator.publicIndexQueries({ company: COMPANY }).every((query) => /site:linkedin\.com\/in/i.test(query)));
    assert.equal(operator.serpApiPublicFallbackEnabled({}), false, 'SerpApi must be opt-in so normal enrichment cannot consume monthly search quota.');
    const parsedRss = directSearch.parseBingRss('<?xml version="1.0"?><rss><channel><item><title>Jane &amp; Team</title><link>https://www.linkedin.com/in/jane-test</link><description><![CDATA[<b>Recruiter</b> at Example]]></description></item></channel></rss>');
    assert.equal(parsedRss.length, 1);
    assert.equal(parsedRss[0].title, 'Jane & Team');
    assert.equal(parsedRss[0].snippet, 'Recruiter at Example');
    const parsedHtml = directSearch.parseBingHtml('<ol><li class="b_algo"><h2><a href="https://www.linkedin.com/in/jane-test">Jane &amp; Team</a></h2><div class="b_caption"><p>Recruiter at Example</p></div></li></ol>');
    assert.equal(parsedHtml.length, 1);
    assert.equal(parsedHtml[0].url, 'https://www.linkedin.com/in/jane-test');
    assert.equal(directSearch.siteConstraint('site:linkedin.com/in "Example" recruiter'), 'linkedin.com');
    assert.equal(directSearch.matchesSite('https://www.linkedin.com/in/jane-test', 'linkedin.com'), true);
    assert.equal(directSearch.matchesSite('https://example.com/jane-test', 'linkedin.com'), false);

    const structuredCompanyProfile = {
      sections: {
        main_profile: {
          name: COMPANY,
          linkedin_url: 'https://www.linkedin.com/company/hanvitt-consulting-solutions/',
        },
        about: {
          description: 'Hanvitt Consulting & Solutions provides technology consulting services.',
        },
      },
      references: {
        company: [{ kind: 'company_urn', value: '123456789' }],
      },
    };
    assert.equal(
      operator.linkedinCompanyProfileMatches(structuredCompanyProfile, { company: COMPANY, domain: '' }),
      true,
      'nested MCP company profile sections must match the verified employer instead of coercing to [object Object]'
    );
    assert.deepEqual(
      [...operator.collectLinkedInCompanyUrns(structuredCompanyProfile)],
      ['123456789'],
      'company URN must remain extractable from structured MCP references'
    );

    await runSerpCase();
    await runTinyFishCase();
    await runExistingRepairCase();
    await runMismatchCase();
    console.log('Universal public-index fallback self-test passed: keyless direct search is primary, SerpApi is opt-in, Apollo remains the exact identity/employer authority, and mismatched employers are rejected.');
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
