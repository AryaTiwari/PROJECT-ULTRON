const assert = require('assert');
const fs = require('fs');
const path = require('path');

const normalizer = require('../core/three-poc-linkedin-profile-normalizer');

const rawSections = {
  url: 'https://www.linkedin.com/in/example/',
  sections: {
    main_profile: 'Example Person\nSenior Technical Recruiter at Northstar Technologies\nKolkata, India',
    experience: [
      'Senior Technical Recruiter\nNorthstar Technologies · Full-time\nJan 2025 - Present',
      'Recruiter\nOld Employer Pvt Ltd\n2022 - 2024',
    ],
  },
};

assert.ok(normalizer.sectionsFrom(rawSections));
const evidence = normalizer.evidenceFrom(rawSections);
assert.match(evidence, /MAIN PROFILE/);
assert.match(evidence, /Northstar Technologies/);
assert.match(evidence, /EXPERIENCE/);
assert.match(evidence, /Old Employer/);
assert.equal(normalizer.existingEmployer(rawSections), '');

const deterministic = normalizer.deterministicCurrentEmployer(rawSections);
assert.ok(deterministic);
assert.equal(deterministic.company, 'Northstar Technologies');
assert.equal(deterministic.title, 'Senior Technical Recruiter');
assert.ok(deterministic.confidence >= 0.95);

assert.equal(normalizer.evidenceContains('Northstar Technologies Pvt. Ltd.', evidence), true,
  'legal suffix differences must not invalidate exact-profile employer evidence');
assert.equal(normalizer.evidenceContains('Completely Different Holdings', evidence), false);

const nested = { result: rawSections };
assert.ok(normalizer.sectionsFrom(nested), 'nested result.sections must be recognized');
assert.match(normalizer.evidenceFrom(nested), /Northstar Technologies/);

const alreadyStructured = { current_company: 'Structured Employer', sections: rawSections.sections };
assert.equal(normalizer.existingEmployer(alreadyStructured), 'Structured Employer');

const previousOnly = {
  sections: {
    main_profile: 'Example Person\nRecruiter',
    experience: ['Recruiter\nOld Employer Pvt Ltd\n2022 - 2024'],
  },
};
assert.equal(normalizer.deterministicCurrentEmployer(previousOnly), null,
  'a historical employer without Present/current evidence must never be promoted to current');

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-linkedin-profile-normalizer.js'), 'utf8');
const controller = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-domain-controller.js'), 'utf8');
assert.match(source, /Profile Employer Normalizer/);
assert.match(source, /deterministicCurrentEmployer/);
assert.match(source, /evidenceMismatch/);
assert.match(source, /resolvedFalse/);
assert.match(source, /malformedJson/);
assert.match(source, /current_company: resolved\.company/);
assert.match(controller, /three-poc-linkedin-profile-normalizer/);

const anchorIndex = controller.indexOf('three-poc-linkedin-anchor-fallback');
const resilienceIndex = controller.indexOf('three-poc-linkedin-profile-resilience');
const normalizerIndex = controller.indexOf('three-poc-linkedin-profile-normalizer');
const diversityIndex = controller.indexOf('three-poc-omniroute-diversity');
assert.ok(anchorIndex >= 0 && resilienceIndex > anchorIndex && normalizerIndex > resilienceIndex && diversityIndex > normalizerIndex,
  '3-POC wrapper install order must be anchor -> resilience -> raw-section normalizer -> OmniRoute diversity');

console.log('3-POC LinkedIn profile normalizer self-test passed: explicit Present/current experience resolves deterministically, legal-name suffix variants remain evidence-anchored, and historical employers stay rejected.');
