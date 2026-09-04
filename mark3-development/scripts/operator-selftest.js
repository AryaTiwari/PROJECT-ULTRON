const operator = require('../core/operator');

function assert(condition, message) { if (!condition) throw new Error(message); }

assert(operator.match('Post this reel on Instagram')?.id === 'instagram_publish', 'Instagram reel publishing intent must route to the Instagram publisher.');
assert(operator.match('Check my Instagram DMs and reply to leads')?.id === 'instagram_dm', 'Instagram DM work must route to the DM operator.');
assert(operator.match('Find 50 fitness creators in India for Elevate outreach')?.id === 'creator_research', 'Creator discovery must route to research.');
assert(operator.match('Extract leads from my inbox')?.id === 'lead_extraction', 'Lead extraction must be recognized.');
assert(operator.match('Publish a founder post on LinkedIn')?.id === 'linkedin_publish', 'LinkedIn posting must be recognized.');
assert(operator.match('Automate the Creator Upgrade Program onboarding')?.id === 'cup_automation', 'CUP automation must be recognized.');
assert(operator.match('Build a new creator analytics feature')?.id === 'software_build', 'Software builds must route to Forge capability.');
assert(operator.match('Build me a gold trading bot')?.id === 'trading_research', 'Trading requests must route to trading research/paper execution safety mode.');

const trading = operator.status().find((row) => row.id === 'trading_research');
assert(trading?.mode === 'research-paper-only', 'Trading operator must not enable autonomous real-money execution.');
assert(/Real-money autonomous execution is disabled/i.test(trading?.purpose || ''), 'Trading operator status must clearly state the real-money execution boundary.');

const research = operator.status().find((row) => row.id === 'creator_research');
assert(research?.ready === true, 'Public creator research should be available with the existing web/research layer.');

console.log('ULTRON Operator self-test passed: Instagram publishing, DMs, creator research, lead extraction, LinkedIn, CUP, Forge and paper-trading capability routing validated.');
