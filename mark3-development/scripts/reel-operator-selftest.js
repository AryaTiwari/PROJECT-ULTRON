const reels = require('../core/reel-operator-bootstrap');
const pipeline = require('../core/reel-pipeline');
const narrator = require('../core/reel-narrator');

function assert(condition, message) { if (!condition) throw new Error(message); }

assert(reels.isReelFactoryRequest('Ultron, make me a reel about why creators plateau at 5k followers.'), 'Natural make-a-reel command must be recognized.');
assert(reels.isReelFactoryRequest('Generate a 30 second dark cinematic Instagram video about creator retention.'), 'Instagram video generation command must be recognized.');
assert(!reels.isReelFactoryRequest('Post this reel on Instagram'), 'Publishing must remain separate from Reel Factory generation.');
assert(!reels.isReelFactoryRequest('Schedule this reel for tomorrow'), 'Scheduling must remain separate from Reel Factory generation.');
assert(reels.isReelAttachmentRequest('Ultron, attach the last reel'), 'Latest Reel attachment command must be recognized.');
assert(reels.isReelAttachmentRequest('Send me the latest reel file'), 'Natural latest Reel file request must be recognized.');
assert(!reels.isReelAttachmentRequest('Post the latest reel on Instagram'), 'Instagram publishing must not be mistaken for Reel attachment delivery.');
assert(reels.isReelStatusRequest('Reel Factory status'), 'Reel Factory status request must be recognized.');
assert(reels.parseDuration('make a 45 second reel about growth') === 45, 'Explicit Reel duration must be parsed.');
assert(reels.parseDuration('make a reel about growth') === 30, 'Default Reel duration must remain 30 seconds.');
assert(/dark/.test(reels.parseStyle('make a dark cinematic premium reel')), 'Style parser must preserve requested dark styling.');
assert(/cinematic/.test(reels.parseStyle('make a dark cinematic premium reel')), 'Style parser must preserve requested cinematic styling.');
assert(reels.extractBrief('Ultron, make me a reel about why creators plateau at 5k followers.') === 'why creators plateau at 5k followers', 'Reel topic extraction must isolate the production brief.');
assert(typeof pipeline.build === 'function', 'Finished Reel pipeline must be installed.');
assert(typeof pipeline.applyVisualPolish === 'function', 'Premium visual polish layer must be installed.');
assert(typeof pipeline.localMusicTrack === 'function', 'Zero-cost local music layer must be installed.');
assert(typeof reels.registerReelArtifact === 'function', 'Rendered Reels must support File Vault artifact delivery.');
assert(typeof reels.latestRenderedReel === 'function', 'Latest rendered Reel lookup must be available without re-rendering.');
assert(/\.mp4$/i.test(reels.artifactName({ job: { id: 'test-reel-job' } })), 'Reel chat artifact must preserve MP4 delivery.');

const strategyIntent = narrator.inferIntent({ style: 'dark cinematic premium', brief: 'why creators stop growing and how to fix retention' });
assert(strategyIntent.includes('educational') && strategyIntent.includes('strategy') && strategyIntent.includes('premium'), 'Creator strategy Reels must infer calm educational/premium narrator intent.');
const comedyIntent = narrator.inferIntent({ style: 'fast-paced', brief: 'funny sarcastic myth-busting hot take about creator advice' });
assert(comedyIntent.includes('witty') && comedyIntent.includes('sarcastic'), 'Comedy/myth-busting Reels must infer witty narrator intent.');
const trendIntent = narrator.inferIntent({ style: 'energetic fast-paced', brief: 'viral creator challenge trend' });
assert(trendIntent.includes('energetic') && trendIntent.includes('high-energy'), 'Trend/challenge Reels must infer high-energy narrator intent.');

console.log('ULTRON Reel Operator self-test passed: natural generation, MP4 delivery, publish separation and content-aware narrator intent routing validated.');
