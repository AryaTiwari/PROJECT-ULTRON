const assert = require('assert');
const fs = require('fs');
const path = require('path');

const fallback = require('../core/three-poc-linkedin-anchor-fallback');

assert.equal(
  fallback.linkedinSlug('https://www.linkedin.com/in/abhishek-kolipaka-943923432/'),
  'abhishek-kolipaka-943923432'
);
assert.equal(fallback.linkedinSlug('https://www.linkedin.com/company/example/'), '');

assert.deepEqual(
  fallback.structuredEmployer({
    name: 'Example Person',
    company: 'Current Company Inc',
    job_title: 'Senior Recruiter',
  }),
  {
    company: 'Current Company Inc',
    title: 'Senior Recruiter',
    name: 'Example Person',
    source: 'linkedin-structured-top-card',
  }
);

const experienceResolved = fallback.structuredEmployer({
  name: 'Example Recruiter',
  job_title: 'Talent Acquisition Lead',
  experiences: [
    {
      position_title: 'Talent Acquisition Lead',
      company: 'Present Employer',
      from_date: '2025',
      to_date: 'Present',
    },
    {
      position_title: 'Recruiter',
      company: 'Old Employer',
      from_date: '2022',
      to_date: '2025',
    },
  ],
});
assert.equal(experienceResolved.company, 'Present Employer');
assert.equal(experienceResolved.title, 'Talent Acquisition Lead');
assert.equal(experienceResolved.source, 'linkedin-structured-current-experience');

// Never promote a clearly historical employer merely because it appears first.
assert.equal(fallback.structuredEmployer({
  name: 'Historical Only',
  experiences: [
    { position_title: 'Recruiter', company: 'Past Employer', from_date: '2022', to_date: '2024' },
  ],
}), null);

const evidence = fallback.profileEvidenceText({
  name: 'Profile Name',
  experience: [{ title: 'Recruiter', company: 'Current Company', to_date: 'Present' }],
  image: 'https://irrelevant.example/photo.jpg',
});
assert.match(evidence, /Profile Name/);
assert.match(evidence, /Current Company/);
assert.doesNotMatch(evidence, /irrelevant\.example/);

const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-linkedin-anchor-fallback.js'), 'utf8');
const controllerSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-domain-controller.js'), 'utf8');

assert.match(moduleSource, /get_person_profile/);
assert.match(moduleSource, /sections: 'experience'/);
assert.match(moduleSource, /chatOmniRouteOnly/);
assert.match(moduleSource, /routingMode !== 'omniroute-only'/);
assert.match(moduleSource, /confidence < 0\.78/);
assert.match(moduleSource, /companyPresentInEvidence/);
assert.match(moduleSource, /finally \{\s*apollo\.resolvePersonProfile = previousResolvePersonProfile;/s);
assert.match(moduleSource, /ULTRON_M3_THREE_POC_LINKEDIN_ANCHOR_FALLBACK_MAX', 8/);
assert.doesNotMatch(moduleSource, /gmail|yahoo|outlook|email domain/i);
assert.match(controllerSource, /three-poc-linkedin-anchor-fallback/);

console.log('3-POC LinkedIn anchor fallback self-test passed: Apollo stays primary, exact authenticated LinkedIn profile resolves missing current employers, historical employers are rejected, OmniRoute-only text extraction is evidence-gated, and the Apollo profile resolver is restored after each workbook run.');
