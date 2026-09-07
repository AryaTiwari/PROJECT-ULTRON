const creatorResearch = require('../core/creator-research');
const instagramDm = require('../core/instagram-dm');

(async () => {
  console.log('ULTRON Creator Outreach live diagnostic (READ ONLY)');
  console.log('Creator Research status:', creatorResearch.status());
  console.log('Instagram DM status:', instagramDm.status());

  console.log('\n[1/2] India creator discovery sample...');
  try {
    const result = await creatorResearch.discover({ market: 'India', niche: 'fitness', limit: 5 });
    console.log({
      ok: result.ok,
      count: result.count,
      candidates: result.candidates.map((lead) => ({
        handle: lead.handle,
        city: lead.city,
        marketConfidence: lead.marketConfidence,
        fitScore: lead.fitScore,
        followerCount: lead.followerCount,
        source: lead.source,
      })),
      errors: result.errors,
    });
  } catch (error) {
    console.error('Creator research live check failed:', error.message);
  }

  console.log('\n[2/2] Instagram conversation read check (NO SEND)...');
  try {
    const result = await instagramDm.listConversations({ limit: 5 });
    console.log({
      ok: result.ok,
      count: result.count,
      conversations: result.conversations.map((conversation) => ({
        id: conversation.id,
        updatedTime: conversation.updatedTime,
        participants: conversation.participants.map((participant) => ({ id: participant.id, username: participant.username })),
      })),
    });
    console.log('Instagram DM read permission is working. No message was sent.');
  } catch (error) {
    console.error('Instagram DM read check failed:', error.message);
    if (/permission|manage_messages|oauth|access token|(#10)|(#200)/i.test(error.message)) {
      console.error('Permission hint: grant instagram_business_manage_messages to the Instagram Login token/app, then generate/refresh the token and retry.');
    }
  }
})().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
