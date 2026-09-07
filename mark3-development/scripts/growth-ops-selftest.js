const operator = require('../core/operator');
const bootstrap = require('../core/operator-bootstrap');
const creatorResearch = require('../core/creator-research');
const instagramDm = require('../core/instagram-dm');

function assert(condition, message) { if (!condition) throw new Error(message); }

const request = creatorResearch.requestFromText('Find 30 fitness creators for Elevate outreach');
assert(request.market === 'India', 'Creator research must default to India when no global market is explicitly requested.');
assert(request.limit === 30, 'Creator research must preserve requested lead count.');
assert(request.niche === 'fitness', 'Creator research must extract a creator niche from natural language.');

const global = creatorResearch.requestFromText('Find 20 finance creators worldwide');
assert(global.market === 'global', 'Explicit worldwide creator research must override the India default.');

const queries = creatorResearch.buildQueries(request);
assert(queries.length >= 4, 'India creator research must build multiple discovery queries.');
assert(queries.some((query) => /Indian|India/i.test(query)), 'India creator queries must contain explicit India intent.');
assert(queries.some((query) => /site:instagram\.com/i.test(query)), 'Creator discovery must target public Instagram profile evidence.');

const candidate = creatorResearch.extractCandidate({
  title: 'Demo Fitness Creator (@demo.fit)',
  snippet: 'Indian fitness creator from Kolkata with 24.5K followers',
  url: 'https://www.instagram.com/demo.fit/',
  source: 'selftest',
}, request);
assert(candidate?.handle === 'demo.fit', 'Creator extraction must normalize an Instagram handle.');
assert(candidate?.market === 'India' && candidate?.city === 'Kolkata', 'Creator extraction must preserve strong India/city evidence.');
assert(candidate?.followerCount === 24500, 'Follower count may be parsed only when public evidence explicitly states it.');
assert(candidate?.followerCountSource === 'public-search-snippet', 'Parsed follower count must retain evidence provenance.');

const noMetric = creatorResearch.extractCandidate({
  title: '@quiet.creator',
  snippet: 'Indian creator from Mumbai',
  url: 'https://www.instagram.com/quiet.creator/',
  source: 'selftest',
}, { ...request, niche: 'creator' });
assert(noMetric?.followerCount === null, 'Creator research must never invent follower counts.');

const deduped = creatorResearch.dedupe([
  { ...candidate, fitScore: 70 },
  { ...candidate, sourceUrl: 'https://example.com/evidence', fitScore: 80 },
]);
assert(deduped.length === 1 && deduped[0].fitScore === 80, 'Creator leads must dedupe by normalized Instagram identity and keep the strongest evidence record.');

assert(operator.match('Find 50 fitness creators in India for Elevate outreach')?.id === 'creator_research', 'Natural creator discovery must route to India Creator Research.');
assert(operator.match('Check my Instagram DMs and reply to leads')?.id === 'instagram_dm', 'Inbox/reply work must route to Instagram DM Operator.');

assert(bootstrap.isInstagramCheckRequest('Check my Instagram connection') === true, 'Explicit Instagram connection checks must still route to connection verification.');
assert(bootstrap.isInstagramCheckRequest('Check my Instagram DMs') === false, 'Instagram DM checks must never be swallowed by the connection-check matcher.');
assert(bootstrap.isDmInboxRequest('Check my Instagram DMs') === true, 'Instagram inbox checks must route to the DM inbox handler.');
assert(bootstrap.parseDmMessagesRequest('Show messages with @demo.fit')?.handle === 'demo.fit', 'Natural conversation-read requests must preserve the creator handle.');
assert(bootstrap.parseDmDraftRequest('Draft a DM for @demo.fit')?.handle === 'demo.fit', 'Cold first-contact draft requests must preserve the creator handle.');
assert(bootstrap.parseExplicitDmSend('Reply to @demo.fit saying Thanks, I will send the details.')?.text === 'Thanks, I will send the details.', 'Explicit reply parsing must preserve the exact approved text.');
assert(bootstrap.isCreatorLeadListRequest('Show my saved creator leads') === true, 'Saved creator pipeline requests must route locally without launching another search.');

const draft = instagramDm.draftColdOutreach({ handle: 'demo.fit', niche: 'fitness', displayName: '' });
assert(draft.canSendViaOfficialApi === false && draft.delivery === 'manual-first-contact', 'Cold Instagram outreach must remain manual-first-contact.');
assert(/Elevate OS/i.test(draft.text) && /elevateos\.in/i.test(draft.text), 'Cold outreach draft must preserve Elevate OS positioning and website.');

const dmStatus = instagramDm.status();
assert(dmStatus.approvalRequired === true, 'Live DM replies must stay approval-gated.');
assert(dmStatus.coldOutreachViaOfficialApi === false, 'The official API must never be represented as a cold-DM sender.');
assert(dmStatus.usernameConversationLookupImplemented === true, 'DM connector must support resolving inbound conversations by Instagram username.');
assert(dmStatus.webhookIngestionImplemented === false, 'Webhook ingestion must remain honestly marked unfinished until it exists.');

const researchStatus = creatorResearch.status();
assert(researchStatus.indiaFirst === true, 'Creator Research status must expose India-first default market.');
assert(researchStatus.publicEvidenceOnly === true, 'Creator Research must remain grounded in public evidence.');
assert(/never-invent/i.test(researchStatus.metricsPolicy), 'Creator Research must explicitly prohibit invented metrics.');

console.log('ULTRON Growth Ops self-test passed: India-first creator discovery, evidence/dedupe rules, creator lead pipeline routing, compliant DM drafts, inbound conversation reads and approval-gated reply semantics validated.');