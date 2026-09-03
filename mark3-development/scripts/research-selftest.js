const web = require('../core/web');
const modes = require('../core/operating-modes');
const founder = require('../core/founder-behavior');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const trends = web.researchProfile('What creator trends are gaining momentum in India today?');
assert(trends.shouldResearch, 'Current creator trend questions must trigger research.');
assert(trends.sources.includes('hootsuite'), 'Creator trend questions must include Hootsuite.');
assert(trends.sources.includes('general'), 'Creator trend questions must retain general web cross-checking.');

const collabs = web.researchProfile('Find current paid brand collabs for Indian fitness creators.');
assert(collabs.shouldResearch, 'Current creator collab questions must trigger research.');
assert(collabs.sources.includes('afluencer-india'), 'Indian collab research must include Afluencer India.');
assert(collabs.sources.includes('afluencer-global'), 'Indian collab research must include global Afluencer context.');
assert(collabs.sources.includes('general'), 'Collab research must retain broader TinyFish cross-checking.');

const product = web.researchProfile('Compare the current pricing of two SaaS tools and tell me which is worth it.');
assert(product.shouldResearch, 'Current product/pricing comparisons must trigger research.');
assert(product.sources.includes('general'), 'General product comparisons must use broad TinyFish research.');
assert(!product.sources.includes('hootsuite') && !product.sources.some((source) => source.startsWith('afluencer-')), 'Creator-only sources must not leak into unrelated product research.');

const webStatus = web.status();
assert(webStatus.research?.adaptive === true, 'Adaptive research status is missing.');
assert(webStatus.research?.sources?.hootsuite?.role === 'creator-trend-signal', 'Hootsuite source role is missing.');
assert(webStatus.research?.sources?.afluencer?.exhaustive === false, 'Afluencer must be explicitly marked non-exhaustive.');

const previous = modes.status().mode;
try {
  modes.setMode('influencer', 'research-selftest');
  assert(modes.routeTask('What creator trends are moving today?', 'general') === 'research', 'Influencer mode must route current trend questions to research models.');
  assert(modes.routeTask('Find paid brand collabs for fitness creators', 'general') === 'research', 'Influencer mode must route collab discovery to research models.');
  const messages = founder.apply([
    { role: 'system', content: 'You are ULTRON Mark 3, a persistent personal operating assistant.' },
    { role: 'user', content: 'Find current brand collabs for Indian creators.' },
  ]);
  const system = String(messages[0]?.content || '');
  assert(/Hootsuite/i.test(system), 'Founder research discipline must know Hootsuite trend evidence.');
  assert(/Afluencer/i.test(system), 'Founder research discipline must know Afluencer marketplace evidence.');
  assert(/not guaranteed to expose the complete logged-in marketplace/i.test(system), 'Afluencer coverage limitation must be explicit.');
} finally {
  modes.setMode(previous || 'executive', 'research-selftest-restore');
}

console.log('ULTRON research self-test passed: adaptive TinyFish research, Hootsuite trends, Afluencer India/global collabs and evidence boundaries validated.');
