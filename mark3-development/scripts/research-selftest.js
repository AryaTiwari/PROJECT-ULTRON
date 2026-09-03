const web = require('../core/web');
const researchAgent = require('../core/research-agent');
const modes = require('../core/operating-modes');
const founder = require('../core/founder-behavior');
const conversation = require('../core/conversation');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const trends = web.researchProfile('What creator trends are gaining momentum in India today?');
assert(trends.shouldResearch, 'Current creator trend questions must trigger research.');
assert(trends.sources.includes('hootsuite'), 'Creator trend questions must include Hootsuite.');
assert(trends.sources.includes('general'), 'Creator trend questions must retain general web cross-checking.');

const exactUserTask = 'Ultron this is not what I asked you to do I basically asked you to find me some trending themes in which I can suggest my clients to make video which can actually be useful';
const normalizedTask = researchAgent.resolve(exactUserTask, []);
assert(normalizedTask?.kind === 'content-trends', 'Natural client-video trend requests must resolve as content-trend research.');
assert(!/\bultron\b/i.test(normalizedTask.query), 'Canonical research query must strip the wake-name invocation.');
assert(!/not what i asked/i.test(normalizedTask.query), 'Canonical research query must strip correction/meta chatter.');
const normalizedProfile = web.researchProfile(normalizedTask.query);
assert(normalizedProfile.sources.includes('hootsuite'), 'Client-video trend research must automatically use Hootsuite.');
assert(normalizedProfile.sources.includes('general'), 'Client-video trend research must retain broad TinyFish evidence.');

const history = [
  { role: 'user', content: exactUserTask },
  { role: 'assistant', content: 'Sir, I am executing the search for current Indian video trends now.' },
];
const resumed = researchAgent.resolve('Ultron so what are you waiting for just do it', history);
assert(resumed?.resumed === true, 'Natural push language must resume the previous research task.');
assert(resumed?.kind === 'content-trends', 'Resumed research must preserve the original content-trend task.');
assert(resumed?.query === normalizedTask.query, 'Continuation must execute the same canonical research task rather than searching the continuation phrase.');
assert(conversation.isContinuation('what are you waiting for just do it'), 'Conversation layer must recognize “what are you waiting for just do it” as continuation.');
assert(conversation.isContinuation('just do it'), 'Conversation layer must recognize “just do it” as continuation.');
const delivery = researchAgent.deliveryInstruction(resumed);
assert(/already run/i.test(delivery) && /do not say you are going to search/i.test(delivery), 'Research delivery must prohibit intention-only responses after tools complete.');

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

console.log('ULTRON research self-test passed: autonomous source selection, cleaned research intent, natural continuation execution, Hootsuite trends, Afluencer collabs and evidence boundaries validated.');
