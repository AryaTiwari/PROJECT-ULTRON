const operator = require('../core/operator');
const operatorBootstrap = require('../core/operator-bootstrap');
const instagram = require('../core/instagram');
const instagramDm = require('../core/instagram-dm');
const creatorResearch = require('../core/creator-research');

function assert(condition, message) { if (!condition) throw new Error(message); }

assert(operator.match('Post this reel on Instagram')?.id === 'instagram_publish', 'Instagram reel publishing intent must route to the Instagram publisher.');
assert(operator.match('Check my Instagram DMs and reply to leads')?.id === 'instagram_dm', 'Instagram DM work must route to the DM operator.');
assert(operator.match('Ultron, make me a 25 second Reel about creator growth')?.id === 'reel_generation', 'Natural Reel generation must be a first-class operator capability.');
assert(operator.match('Suggest Reel ideas based on my Instagram aesthetic')?.id === 'reel_strategy', 'Reel strategy/aesthetic work must route to the Reel analyst.');
assert(operator.match('Ultron, audit yourself and tell me what is broken')?.id === 'system_audit', 'System-health intent must route to Turbo audit capability.');
assert(operator.match('What have you learned about my style?')?.id === 'adaptive_operator', 'Learned-preference intent must route to Adaptive Founder Intelligence.');
assert(operator.match('Find 50 fitness creators in India for Elevate outreach')?.id === 'creator_research', 'Creator discovery must route to research.');
assert(operator.match('Extract leads from my inbox')?.id === 'lead_extraction', 'Lead extraction must be recognized.');
assert(operator.match('Publish a founder post on LinkedIn')?.id === 'linkedin_publish', 'LinkedIn posting must be recognized.');
assert(operator.match('Automate the Creator Upgrade Program onboarding')?.id === 'cup_automation', 'CUP automation must be recognized.');
assert(operator.match('Build a new creator analytics feature')?.id === 'software_build', 'Software builds must route to Forge capability.');
assert(operator.match('Build me a gold trading bot')?.id === 'trading_research', 'Trading requests must route to trading research/paper execution safety mode.');
assert(operatorBootstrap.isInstagramCheckRequest('Ultron, check Instagram connection') === true, 'Natural Instagram connection checks must route deterministically.');
assert(operatorBootstrap.isInstagramCheckRequest('Verify my Instagram API') === true, 'Instagram API verification wording must route deterministically.');
assert(operatorBootstrap.isDmInboxRequest('Check my Instagram DMs') === true, 'Instagram inbox checks must route deterministically.');
assert(operatorBootstrap.parseDmDraftRequest('Draft an Instagram DM for @demo.creator')?.handle === 'demo.creator', 'Cold DM draft intent must preserve creator handle.');
assert(operatorBootstrap.parseExplicitDmSend('Send a DM to @demo.creator saying hello there')?.text === 'hello there', 'Explicit DM send parser must capture the exact approved message.');

const igStatus = instagram.status();
assert(typeof igStatus.tokenConfigured === 'boolean' && typeof igStatus.accountIdConfigured === 'boolean', 'Instagram connector status must expose credential readiness without exposing secret values.');

const dmStatus = instagramDm.status();
assert(dmStatus.implemented === true && dmStatus.repliesImplemented === true, 'Instagram DM connector must expose implemented reply support.');
assert(dmStatus.approvalRequired === true, 'Instagram DM sends must remain approval-gated.');
assert(dmStatus.coldOutreachViaOfficialApi === false, 'Official Instagram API must never be represented as a cold-DM sender.');
assert(dmStatus.requiredPermission === 'instagram_business_manage_messages', 'DM connector must expose the required Meta messaging permission.');

const creatorStatus = creatorResearch.status();
assert(creatorStatus.implemented === true && creatorStatus.indiaFirst === true, 'Creator research must default to India-first discovery.');
assert(creatorStatus.publicEvidenceOnly === true, 'Creator research must stay grounded in public evidence.');
assert(/never-invent/i.test(creatorStatus.metricsPolicy), 'Creator research must never invent follower/engagement metrics.');

const rows = operator.status();
const trading = rows.find((row) => row.id === 'trading_research');
assert(trading?.mode === 'research-paper-only', 'Trading operator must not enable autonomous real-money execution.');
assert(/Real-money autonomous execution is disabled/i.test(trading?.purpose || ''), 'Trading operator status must clearly state the real-money execution boundary.');
assert(trading?.ready === true, 'Trading research and paper execution should remain available without a broker connector.');

const research = rows.find((row) => row.id === 'creator_research');
assert(research?.implemented === true, 'India Creator Research must be implemented.');
assert(research?.ready === Boolean(creatorStatus.providers.tinyfishPrimary || creatorStatus.providers.tavilyFallback), 'Creator Research readiness must match configured search providers.');

const dm = rows.find((row) => row.id === 'instagram_dm');
assert(dm?.implemented === true, 'Instagram DM Operator must expose its implemented compliant reply connector.');
assert(dm?.ready === dmStatus.configured, 'Instagram DM readiness must match token/account configuration.');

const forge = rows.find((row) => row.id === 'software_build');
assert(forge?.ready === true, 'Forge software building must remain an operator capability.');
const audit = rows.find((row) => row.id === 'system_audit');
assert(audit?.implemented === true && audit.ready === true, 'Turbo System Integrity must be exposed as an executable operator capability.');
const adaptive = rows.find((row) => row.id === 'adaptive_operator');
assert(adaptive?.implemented === true && adaptive.ready === true, 'Adaptive Founder Intelligence must be exposed as an executable operator capability.');

for (const id of ['instagram_publish', 'lead_extraction', 'linkedin_publish', 'cup_automation']) {
  const row = rows.find((item) => item.id === id);
  assert(row && row.implemented === false, `${id} must not claim connector implementation before its deterministic live connector exists.`);
  assert(row.ready === false, `${id} must not claim it can execute merely because credentials may exist.`);
}

console.log('ULTRON Operator self-test passed: India-first creator research, compliant Instagram DM replies, Reel/Adaptive/Turbo routing, honest connector readiness and paper-trading boundaries validated.');
