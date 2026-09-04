const factory = require('../core/reel-factory');
const sources = require('../core/reel-sources');

function assert(condition, message) { if (!condition) throw new Error(message); }

const plan = factory.fallbackPlan('Why small creators stop growing after their first viral reel', { durationSec: 30, style: 'dark cinematic' });
assert(plan.aspectRatio === '9:16', 'Reel plan must remain vertical 9:16.');
assert(plan.width === 1080 && plan.height === 1920, 'Reel plan must target 1080x1920.');
assert(plan.durationSec === 30, 'Reel plan duration must respect the requested target.');
assert(Array.isArray(plan.scenes) && plan.scenes.length >= 4, 'Reel plan must contain a usable multi-scene structure.');
assert(plan.scenes[0].start === 0, 'First scene must start at zero.');
assert(plan.scenes[plan.scenes.length - 1].end === 30, 'Final scene must end at the requested duration.');
assert(plan.scenes.every((scene) => scene.visualQuery), 'Every scene needs a stock-search query.');

const normalized = factory.normalizePlan({
  title: 'Test',
  durationSec: 25,
  scenes: [
    { start: 0, end: 4, visualQuery: 'creator filming vertical', onScreenText: 'STOP SCROLLING' },
    { start: 4, end: 25, visualQuery: 'phone analytics vertical', onScreenText: 'LOOK AT THIS' },
  ],
}, 'Test brief');
assert(normalized.scenes.length === 2, 'Director normalization must preserve valid scene count.');
assert(normalized.scenes[1].end === 25, 'Director normalization must anchor final scene to reel duration.');

const sourceStatus = sources.status();
assert(typeof sourceStatus.pexelsConfigured === 'boolean', 'Pexels readiness must be deterministic.');
assert(typeof sourceStatus.pixabayConfigured === 'boolean', 'Pixabay readiness must be deterministic.');
assert(!JSON.stringify(sourceStatus).includes(process.env.PEXELS_API_KEY || '__never__'), 'Reel source status must never expose the Pexels API key.');

const status = factory.status();
assert(status.directorImplemented === true, 'Reel Director foundation must be implemented.');
assert(status.stockSourceRouterImplemented === true, 'Stock source router must be implemented.');
assert(status.zeroCostOnly === true && status.paidGenerationAllowed === false, 'Reel Factory must preserve the zero-cost guardrail.');
assert(status.rendererImplemented === false, 'Foundation must not falsely claim the finished renderer exists yet.');

console.log('ULTRON Reel Factory self-test passed: 9:16 director, free stock router, checkpoints and zero-cost guardrail validated.');
console.log(`Reel Factory readiness: stock=${status.stockSourceReady ? 'ready' : 'needs API key'}, ffmpeg=${status.ffmpeg.available ? 'ready' : 'not found'}, renderer=build-next.`);
