const creatorResearch = require('../core/creator-research');
const instagramDm = require('../core/instagram-dm');

function assert(condition, message) { if (!condition) throw new Error(message); }

(async () => {
  const request = creatorResearch.requestFromText('Find 25 fitness creators in India for Elevate outreach');
  assert(request.market === 'India', 'Creator research must default explicit India requests to India.');
  assert(request.niche === 'fitness', 'Creator research must parse a common creator niche.');
  assert(request.limit === 25, 'Creator research must respect requested lead count within safety limits.');

  assert(creatorResearch.instagramHandleFromUrl('https://www.instagram.com/demo.creator/') === 'demo.creator', 'Instagram profile URLs must normalize to handles.');
  assert(creatorResearch.instagramHandleFromUrl('https://www.instagram.com/reel/ABC123/') === '', 'Instagram Reel URLs must not be mistaken for creator profiles.');
  assert(creatorResearch.parseFollowerCount('12.4K followers') === 12400, 'Public follower K notation must parse deterministically.');
  assert(creatorResearch.parseFollowerCount('2.1 lakh followers') === 210000, 'Indian lakh follower notation must parse deterministically.');
  assert(creatorResearch.parseFollowerCount('creator account, follower count unavailable') === null, 'Unknown follower counts must remain unknown.');

  const candidate = creatorResearch.extractCandidate({
    title: 'Demo Creator (@demo.creator) • Instagram',
    snippet: 'Mumbai, India fitness content creator · 12.4K followers',
    url: 'https://www.instagram.com/demo.creator/',
    source: 'test-public-search',
  }, { market: 'India', niche: 'fitness' });
  assert(candidate?.handle === 'demo.creator', 'Creator candidate must retain normalized Instagram handle.');
  assert(candidate?.market === 'India' && candidate?.city === 'Mumbai', 'India evidence should capture city-level evidence when public search exposes it.');
  assert(candidate?.marketConfidence >= 0.9, 'Explicit Indian city evidence must score strongly.');
  assert(candidate?.followerCount === 12400 && candidate?.followerCountSource === 'public-search-snippet', 'Follower count must retain public evidence provenance.');

  const deduped = creatorResearch.dedupe([
    candidate,
    { ...candidate, fitScore: candidate.fitScore - 5, sourceUrl: 'https://example.com/duplicate' },
  ]);
  assert(deduped.length === 1, 'Duplicate creator handles must collapse to one lead.');

  const draft = instagramDm.draftColdOutreach(candidate);
  assert(draft.delivery === 'manual-first-contact' && draft.canSendViaOfficialApi === false, 'Cold creator outreach must remain manual first-contact under Meta policy.');
  assert(/Elevate OS/i.test(draft.text), 'Cold outreach draft should represent Elevate OS.');

  const dmStatus = instagramDm.status();
  assert(dmStatus.implemented === true && dmStatus.approvalRequired === true, 'Instagram DM connector must be implemented and approval-gated.');
  assert(dmStatus.coldOutreachViaOfficialApi === false, 'DM connector must never claim official cold-DM capability.');
  assert(dmStatus.apiVersion === 'v26.0' || /^v\d+\.0$/.test(dmStatus.apiVersion), 'Instagram DM connector must pin an explicit Graph API version.');

  let approvalBlocked = false;
  try { await instagramDm.sendText('123456', 'test message', { approved: false }); }
  catch (error) { approvalBlocked = error?.code === 'DM_APPROVAL_REQUIRED'; }
  assert(approvalBlocked, 'Instagram DM send must reject before network access when approval is absent.');

  const statusText = JSON.stringify({ creator: creatorResearch.status(), dm: dmStatus });
  assert(!statusText.includes(process.env.INSTAGRAM_TOKEN || '__never__'), 'Creator/DM status must never expose the Instagram token.');

  console.log('ULTRON Creator Outreach self-test passed: India-first discovery, public-evidence metrics, handle dedupe, manual cold-first-contact policy and approval-gated official DM replies validated.');
})().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
