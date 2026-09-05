const finisher = require('../core/reel-finisher');
const finalQuality = require('../core/reel-final-quality');
const narrator = require('../core/reel-narrator');

function assert(condition, message) { if (!condition) throw new Error(message); }

assert(finisher.transitionName('clean-cut') === 'fade', 'Clean cuts should map to a subtle fade transition.');
assert(finisher.transitionName('fast-cut') === 'smoothleft', 'Fast cuts should map to a faster directional transition.');
assert(finisher.transitionDuration(3) >= 0.08 && finisher.transitionDuration(3) <= 0.16, 'Transition duration must stay inside the premium short-form range.');

const intents = narrator.inferIntent({
  style: 'dark cinematic premium',
  brief: 'why creators stop growing after a viral reel',
  transcript: 'Explain retention, conversion and invite creators to a free strategy session with Elevate OS.',
});
assert(intents.includes('educational') && intents.includes('strategy'), 'Creator strategy narration should infer educational/strategy intent.');
assert(intents.includes('premium') && intents.includes('credible'), 'Elevate business narration should infer premium/credible intent.');

const mockPlan = {
  durationSec: 20,
  brandPromotion: true,
  cta: 'Free Strategy Session — Elevate OS — elevateos.in',
  voiceover: 'A viral reel can spike reach without building loyalty. Many viewers liked one topic, not your whole page. If they do not follow or return, the spike dies. Unrelated posts weaken repeat-viewer signals. Build repeatable pillars around the promise that worked. Book a free strategy session with Elevate OS at elevateos.in.',
  scenes: [
    { start: 0, end: 2.4, onScreenText: 'Viral Reach ≠ Growth', narration: 'A viral reel can spike reach without building loyalty.' },
    { start: 2.4, end: 5.4, onScreenText: 'One Topic Won', narration: 'Many viewers liked one topic, not your whole page.' },
    { start: 5.4, end: 8.4, onScreenText: 'Reach Must Convert', narration: 'If they do not follow or return, the spike dies.' },
    { start: 8.4, end: 11.4, onScreenText: 'Next Reel Resets', narration: 'Unrelated posts weaken repeat-viewer signals.' },
    { start: 11.4, end: 16.8, onScreenText: 'Build Repeatable Pillars', narration: 'Build repeatable pillars around the promise that worked.' },
    { start: 16.8, end: 20, onScreenText: 'Free Strategy Session', subText: 'Elevate OS • elevateos.in', narration: 'Book a free strategy session with Elevate OS at elevateos.in.', isBrandCta: true },
  ],
};

const good = finalQuality.audit({
  plan: mockPlan,
  output: { width: 1080, height: 1920, audioPresent: true },
  narration: { narratorProfile: 'Verity', metallicApplied: false },
  polish: { captionsApplied: true, safeZoneApplied: true },
  finisher: { applied: true, transitionsApplied: true, sfxApplied: true },
}, 'why creators stop growing after a viral reel');
assert(good.ok, `Complete Reel should pass final quality gate: ${good.issues.join('; ')}`);

const bad = finalQuality.audit({
  plan: mockPlan,
  output: { width: 1080, height: 1920, audioPresent: true },
  narration: { narratorProfile: null, metallicApplied: false },
  polish: { captionsApplied: true, safeZoneApplied: false },
  finisher: { applied: false, transitionsApplied: false, sfxApplied: false },
}, 'why creators stop growing after a viral reel');
assert(!bad.ok && bad.issues.length >= 3, 'Unfinished Reel must be rejected by final quality gate.');

console.log('ULTRON Reel Finisher self-test passed: intent-aware narrator routing, cinematic transitions, procedural SFX and final production gate validated.');
