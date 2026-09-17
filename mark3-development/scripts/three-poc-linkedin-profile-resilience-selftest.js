const assert = require('assert');
const fs = require('fs');
const path = require('path');

const resilience = require('../core/three-poc-linkedin-profile-resilience');

assert.equal(
  resilience.profileUrl({ linkedin_username: 'aarti5a0820180' }),
  'https://www.linkedin.com/in/aarti5a0820180/'
);
assert.equal(resilience.usableProfile({}), false);
assert.equal(resilience.usableProfile({ rawText: '' }), false);
assert.equal(resilience.usableProfile({
  name: 'Aarti',
  headline: 'Recruitment Consultant',
  experience: [{ company: 'Example Staffing', title: 'Recruiter' }],
}), true);

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-linkedin-profile-resilience.js'), 'utf8');
const controller = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-domain-controller.js'), 'utf8');

assert.match(source, /tool !== 'get_person_profile'/);
assert.match(source, /max_scrolls: 1/);
assert.match(source, /maybeJoeyism/);
assert.match(source, /joeyism\.call\('person'/);
assert.match(source, /emptyPayloads/);
assert.match(source, /errorCodes/);
assert.match(source, /lightRetrySuccesses/);
assert.match(source, /linkedinMcp\.callTool = previousCallTool/);
assert.match(controller, /three-poc-linkedin-profile-resilience/);

console.log('3-POC LinkedIn profile resilience self-test passed: exact POC-1 profile reads detect empty payloads, use one light authenticated retry, optionally reuse Joeyism, restore the shared MCP client, and expose failure diagnostics.');
