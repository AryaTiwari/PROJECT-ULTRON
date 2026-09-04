const operator = require('../core/operator');
const operatorBootstrap = require('../core/operator-bootstrap');
const instagram = require('../core/instagram');

function assert(condition, message) { if (!condition) throw new Error(message); }

assert(operator.match('Post this reel on Instagram')?.id === 'instagram_publish', 'Instagram reel publishing intent must route to the Instagram publisher.');
assert(operator.match('Check my Instagram DMs and reply to leads')?.id === 'instagram_dm', 'Instagram DM work must route to the DM operator.');
assert(operator.match('Find 50 fitness creators in India for Elevate outreach')?.id === 'creator_research', 'Creator discovery must route to research.');
assert(operator.match('Extract leads from my inbox')?.id === 'lead_extraction', 'Lead extraction must be recognized.');
assert(operator.match('Publish a founder post on LinkedIn')?.id === 'linkedin_publish', 'LinkedIn posting must be recognized.');
assert(operator.match('Automate the Creator Upgrade Program onboarding')?.id === 'cup_automation', 'CUP automation must be recognized.');
assert(operator.match('Build a new creator analytics feature')?.id === 'software_build', 'Software builds must route to Forge capability.');
assert(operator.match('Build me a gold trading bot')?.id === 'trading_research', 'Trading requests must route to trading research/paper execution safety mode.');
assert(operatorBootstrap.isInstagramCheckRequest('Ultron, check Instagram connection') === true, 'Natural Instagram connection checks must route deterministically.');
assert(operatorBootstrap.isInstagramCheckRequest('Verify my Instagram API') === true, 'Instagram API verification wording must route deterministically.');

const igStatus = instagram.status();
assert(typeof igStatus.tokenConfigured === 'boolean' && typeof igStatus.accountIdConfigured === 'boolean', 'Instagram connector status must expose credential readiness without exposing secret values.');

const rows = operator.status();
const trading = rows.find((row) => row.id === 'trading_research');
assert(trading?.mode === 'research-paper-only', 'Trading operator must not enable autonomous real-money execution.');
assert(/Real-money autonomous execution is disabled/i.test(trading?.purpose || ''), 'Trading operator status must clearly state the real-money execution boundary.');
assert(trading?.ready === true, 'Trading research and paper execution should remain available without a broker connector.');

const research = rows.find((row) => row.id === 'creator_research');
assert(research?.ready === true, 'Public creator research should be available with the existing web/research layer.');

const forge = rows.find((row) => row.id === 'software_build');
assert(forge?.ready === true, 'Forge software building must remain an operator capability.');

for (const id of ['instagram_publish', 'instagram_dm', 'lead_extraction', 'linkedin_publish', 'cup_automation']) {
  const row = rows.find((item) => item.id === id);
  assert(row && row.implemented === false, `${id} must not claim connector implementation before its deterministic connector exists.`);
  assert(row.ready === false, `${id} must not claim it can execute merely because credentials may exist.`);
}

console.log('ULTRON Operator self-test passed: founder-work routing, natural Instagram verification, honest connector readiness, creator research, Forge and paper-trading boundaries validated.');
