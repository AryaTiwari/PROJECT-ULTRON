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
assert(/book[\s\S]*now/i.test(plan.cta), 'Creator-growth Reel CTA must explicitly ask viewers to book now.');
assert(/Elevate OS/i.test(plan.voiceover), 'Creator-growth Reel narration must include Elevate OS brand close.');
assert(/elevateos\.in/i.test(plan.voiceover), 'Creator-growth Reel narration must include elevateos.in.');
assert(plan.scenes[plan.scenes.length - 1].isBrandCta === true, 'Elevate OS CTA must be the final scene.');

const audit = quality.auditPlan(plan, brief, { durationSec: 20 });
assert(audit.ok, `Fallback Reel plan must pass v2 quality gate: ${audit.issues.join('; ')}`);
assert(audit.wordCount >= audit.requirements.minWords, 'Reel narration must carry sufficient information density.');
assert(audit.requirements.maxOnScreenWords === 5 && audit.requirements.maxSubtitleWords === 5, 'Sparse but useful text-density policy must remain active.');
assert(plan.scenes.slice(1, -1).every((scene) => quality.wordCount(scene.narration) >= audit.requirements.minBodyNarrationWords), 'Body scenes must contain enough narration to explain an idea rather than vague fragments.');

const wrapped = pipeline.wrapText('This headline must stay safely inside a vertical video frame', 18, 2);
assert(wrapped.split('\n').length <= 2, 'Headline wrapper must cap text at two lines.');
assert(pipeline.SAFE.headlineY >= 520 && pipeline.SAFE.headlineY <= 760, 'Headline must stay in the eye-level editorial zone.');
assert(pipeline.SAFE.subtitleY >= 700 && pipeline.SAFE.subtitleY <= 980, 'Supporting text must stay near eye level rather than the lower frame.');
const cues = pipeline.narrationCues(plan);
assert(cues.length >= 3, 'Narration must generate restrained supporting cues.');
assert(cues.every((cue) => quality.wordCount(cue.text) <= 5), 'Supporting cues must stay at five words or fewer.');
for (const scene of plan.scenes.filter((item) => !item.isBrandCta)) {
  const sceneCues = cues.filter((cue) => cue.start >= scene.start && cue.end <= scene.end + 0.01);
  assert(sceneCues.length <= 1, 'Each scene may show at most one supporting cue after the headline.');
  if (sceneCues.length) assert(sceneCues[0].start > scene.start + 0.9, 'Supporting text must wait until the headline has had a clean reading beat.');
}
const fakeFilter = pipeline.drawTextFileFilter('C:/Windows/Fonts/arialbd.ttf', 'C:/tmp/caption.txt', { start: 0, end: 1 });
assert(fakeFilter.includes('box=0'), 'Premium typography must not render translucent caption boxes.');
assert(fakeFilter.includes('shadowcolor='), 'Premium typography should use shadow/outline contrast instead of caption boxes.');

const sourceStatus = sources.status();
assert(sourceStatus.provider === 'pexels', 'Reel Factory must use the enrolled Pexels source only.');
assert(typeof sourceStatus.pexelsConfigured === 'boolean', 'Pexels readiness must be deterministic.');
assert(!Object.prototype.hasOwnProperty.call(sourceStatus, 'pixabayConfigured'), 'Removed Pixabay runtime must not survive in source status.');
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

console.log('ULTRON Reel Factory v2 self-test passed: informative scripts, eye-level boxless typography, restrained support text, mandatory Elevate booking CTA and separate narrator boundary validated.');
console.log(`Reel Factory readiness: stock=${status.stockSourceReady ? 'ready' : 'needs API key'}, ffmpeg=${status.ffmpeg.available ? 'ready' : 'not found'}, renderer=ready, captions=eye-level-minimal-v4, narrator=${status.narrator.configured ? 'ready' : 'needs profile'}.`);
