const factory = require('../core/reel-factory');
const sources = require('../core/reel-sources');
const pipeline = require('../core/reel-pipeline');
const quality = require('../core/reel-quality');
const narrator = require('../core/reel-narrator');

function assert(condition, message) { if (!condition) throw new Error(message); }

const brief = 'Why small creators stop growing after their first viral reel';
const plan = factory.fallbackPlan(brief, { durationSec: 20, style: 'dark cinematic premium' });
assert(plan.aspectRatio === '9:16', 'Reel plan must remain vertical 9:16.');
assert(plan.width === 1080 && plan.height === 1920, 'Reel plan must target 1080x1920.');
assert(plan.durationSec === 20, 'Reel plan duration must respect the requested target.');
assert(Array.isArray(plan.scenes) && plan.scenes.length >= 6, '20-second Reel must contain a complete multi-beat structure.');
assert(plan.scenes[0].start === 0, 'First scene must start at zero.');
assert(plan.scenes[plan.scenes.length - 1].end === 20, 'Final scene must end at the requested duration.');
assert(plan.scenes.every((scene) => scene.visualQuery), 'Every scene needs a stock-search query.');
assert(plan.scenes.every((scene, index) => index === 0 || scene.start >= plan.scenes[index - 1].end), 'Scene timings must never overlap.');
assert(plan.scenes.filter((scene) => !scene.isBrandCta).every((scene) => quality.wordCount(scene.onScreenText) <= 5), 'Main on-screen phrases must stay at five words or fewer.');
assert(/Free Strategy Session/i.test(plan.cta), 'Creator-growth Reel must contain Free Strategy Session CTA.');
assert(/Elevate OS/i.test(plan.voiceover), 'Creator-growth Reel narration must include Elevate OS brand close.');
assert(/elevateos\.in/i.test(plan.voiceover), 'Creator-growth Reel narration must include elevateos.in.');

const audit = quality.auditPlan(plan, brief, { durationSec: 20 });
assert(audit.ok, `Fallback Reel plan must pass v2 quality gate: ${audit.issues.join('; ')}`);
assert(audit.wordCount >= audit.requirements.minWords, 'Reel narration must carry sufficient information density.');
assert(audit.requirements.maxOnScreenWords === 5 && audit.requirements.maxSubtitleWords === 4, 'Sparse text-density policy must remain active.');

const wrapped = pipeline.wrapText('This headline must stay safely inside a vertical video frame', 18, 2);
assert(wrapped.split('\n').length <= 2, 'Headline wrapper must cap text at two lines.');
assert(pipeline.SAFE.headlineY >= 500 && pipeline.SAFE.subtitleY < 1300, 'Caption safe zones must remain away from Instagram UI.');
const cues = pipeline.narrationCues(plan);
assert(cues.length >= 3, 'Narration must generate restrained subtitle cues.');
assert(cues.every((cue) => quality.wordCount(cue.text) <= 4), 'Subtitle cues must stay at four words or fewer.');
for (const scene of plan.scenes.filter((item) => !item.isBrandCta)) {
  const sceneCues = cues.filter((cue) => cue.start >= scene.start && cue.end <= scene.end + 0.01);
  assert(sceneCues.length <= 2, 'Each scene may show at most two short subtitle cues.');
  if (sceneCues.length) assert(sceneCues[0].start > scene.start + 0.45, 'Subtitles must wait until the scene headline has cleared.');
}
const fakeFilter = pipeline.drawTextFileFilter('C:/Windows/Fonts/arialbd.ttf', 'C:/tmp/caption.txt', { start: 0, end: 1 });
assert(fakeFilter.includes('box=0'), 'Premium typography must not render translucent caption boxes.');
assert(fakeFilter.includes('shadowcolor='), 'Premium typography should use shadow/outline contrast instead of caption boxes.');

const sourceStatus = sources.status();
assert(typeof sourceStatus.pexelsConfigured === 'boolean', 'Pexels readiness must be deterministic.');
assert(typeof sourceStatus.pixabayConfigured === 'boolean', 'Pixabay readiness must be deterministic.');
assert(!JSON.stringify(sourceStatus).includes(process.env.PEXELS_API_KEY || '__never__'), 'Reel source status must never expose the Pexels API key.');

const status = factory.status();
const narratorStatus = narrator.status();
assert(status.version === 2, 'Reel Factory v2 must be active.');
assert(status.directorImplemented === true && status.contentQualityGateImplemented === true, 'Reel Director v2 quality gate must be implemented.');
assert(status.safeCaptionLayoutImplemented === true && status.brandCtaImplemented === true, 'Safe caption layout and branded CTA must be installed.');
assert(status.stockSourceRouterImplemented === true, 'Stock source router must be implemented.');
assert(status.zeroCostOnly === true && status.paidGenerationAllowed === false, 'Reel Factory must preserve the zero-cost guardrail.');
assert(typeof narratorStatus.configured === 'boolean' && narratorStatus.ultronVoiceFallbackAllowed === false, 'Reel narrator must be separate and must never silently fall back to Ultron voice.');
assert(typeof pipeline.build === 'function', 'Finished Reel renderer must be installed.');
assert(typeof pipeline.applyVisualPolish === 'function', 'Premium caption/polish layer must be installed.');

console.log('ULTRON Reel Factory v2 self-test passed: complete scripts, sparse boxless typography, non-overlapping text timing, Elevate CTA and separate narrator boundary validated.');
console.log(`Reel Factory readiness: stock=${status.stockSourceReady ? 'ready' : 'needs API key'}, ffmpeg=${status.ffmpeg.available ? 'ready' : 'not found'}, renderer=ready, captions=minimal-clean-v3, narrator=${status.narrator.configured ? 'ready' : 'needs profile'}.`);
