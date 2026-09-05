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
assert(/Free Strategy Session/i.test(plan.cta), 'Creator-growth Reel must contain Free Strategy Session CTA.');
assert(/Elevate OS/i.test(plan.voiceover), 'Creator-growth Reel narration must include Elevate OS brand close.');
assert(/elevateos\.in/i.test(plan.voiceover), 'Creator-growth Reel narration must include elevateos.in.');

const audit = quality.auditPlan(plan, brief, { durationSec: 20 });
assert(audit.ok, `Fallback Reel plan must pass v2 quality gate: ${audit.issues.join('; ')}`);
assert(audit.wordCount >= audit.requirements.minWords, 'Reel narration must carry sufficient information density.');

const wrapped = pipeline.wrapText('This headline must stay safely inside a vertical video frame', 18, 3);
assert(wrapped.split('\n').length <= 3, 'Headline wrapper must cap text lines.');
assert(pipeline.SAFE.headlineY >= 500 && pipeline.SAFE.subtitleY < 1300, 'Caption safe zones must remain around eye-level, away from Instagram UI.');
assert(pipeline.narrationCues(plan).length >= 3, 'Narration must generate timed subtitle cues.');

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

console.log('ULTRON Reel Factory v2 self-test passed: complete scripts, non-overlapping scenes, eye-level safe captions, timed subtitles, Elevate CTA and separate narrator boundary validated.');
console.log(`Reel Factory readiness: stock=${status.stockSourceReady ? 'ready' : 'needs API key'}, ffmpeg=${status.ffmpeg.available ? 'ready' : 'not found'}, renderer=ready, captions=eye-level-safe, narrator=${status.narrator.configured ? 'ready' : 'needs profile'}.`);
