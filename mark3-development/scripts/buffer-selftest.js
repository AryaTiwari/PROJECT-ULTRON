const buffer = require('../core/buffer');
const tools = require('../core/free-tool-registry');

function assert(condition, message) { if (!condition) throw new Error(message); }

const status = buffer.status();
assert(status.implemented === true, 'Buffer connector foundation must remain implemented.');
assert(status.readOnlyVerification === true, 'Buffer must preserve read-only identity/channel verification.');
assert(status.videoDryRun === true, 'Buffer connector must expose video-post dry-run support.');
assert(status.liveWriteEnabled === false, 'Buffer live writes must not silently become enabled.');
assert(status.approvalRequiredForLiveWrite === true, 'Buffer live writes must remain approval-gated.');

const dry = buffer.videoPostDryRun({
  channelId: 'test-instagram-channel',
  text: 'Test Reel',
  mediaUrl: 'https://example.com/reel.mp4',
});
assert(dry.ok && dry.dryRun && dry.externalWritePerformed === false, 'Buffer dry run must never perform an external write.');
assert(dry.input.assets?.[0]?.video?.url === 'https://example.com/reel.mp4', 'Buffer video dry run must preserve the public media URL.');
assert(tools.byId('buffer')?.implemented === true, 'Buffer must remain represented as an implemented connector foundation in the free-tool registry.');
assert(tools.byId('buffer')?.autoUse === 'explicit-feature', 'Buffer must not be silently used for external publishing.');

console.log('ULTRON Buffer self-test passed: free API registry, read-only verification, public-video dry run and approval-gated live-write boundary validated.');
