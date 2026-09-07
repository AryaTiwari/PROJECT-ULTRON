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
  purpose: 'Explain retention, conversion and invite creators to a free strategy session with Elevate OS.',
});
assert(intents.includes('educational') && intents.includes('strategy'), 'Creator strategy narration should infer educational/strategy intent.');
assert(intents.includes('premium') && intents.includes('credible'), 'Elevate business narration should infer premium/credible intent.');

const mockPlan = {
  durationSec: 20,
  brandPromotion: true,
  cta: 'Book your Free Strategy Session now — Elevate OS — elevateos.in',
  voiceover: 'A viral reel can spike reach without building loyalty. Many viewers liked one topic, not your whole page. If they do not follow or return, the spike dies. Unrelated posts weaken repeat-viewer and retention signals after the spike. Build repeatable pillars around the promise that already worked. Want a growth plan built around your account? Book your free strategy session with Elevate OS now at elevateos.in.',
  scenes: [
    { start: 0, end: 2.4, purpose: 'Pattern interrupt', onScreenText: 'Viral Reach ≠ Growth', narration: 'A viral reel can spike reach without building loyalty.' },
    { start: 2.4, end: 5.4, purpose: 'Context', onScreenText: 'One Topic Won', narration: 'Many viewers liked one topic, not your whole page.' },
    { start: 5.4, end: 8.4, purpose: 'Cause', onScreenText: 'Reach Must Convert', narration: 'If they do not follow or return, the spike dies.' },
    { start: 8.4, end: 11.4, purpose: 'Mechanism', onScreenText: 'Next Reel Resets', narration: 'Unrelated posts weaken repeat-viewer and retention signals after the spike.' },
    { start: 11.4, end: 16.6, purpose: 'Action', onScreenText: 'Build Repeatable Pillars', narration: 'Build repeatable pillars around the promise that already worked.' },
    { start: 16.6, end: 20, purpose: 'Brand CTA', onScreenText: 'Book Your Free Strategy Session', subText: 'Elevate OS • elevateos.in', narration: 'Want a growth plan built around your account? Book your free strategy session with Elevate OS now at elevateos.in.', isBrandCta: true },
  ],
};

const good = finalQuality.audit({
  plan: mockPlan,
  output: { width: 1080, height: 1920, audioPresent: true },
  narration: { narratorProfile: 'Verity', metallicApplied: false },
  polish: {
    captionsApplied: true,
    safeZoneApplied: true,
    visualStyle: 'minimal-clean-v3',
    textBoxes: false,
    headlineSubtitleOverlapAvoided: true,
    eyeLevelAligned: true,
    headlineY: 610,
    subtitleY: 840,
    brandCtaVersion: 'elevate-book-now-v1',
    maxHeadlineWords: 5,
    maxSubtitleWords: 5,
  },
  finisher: { applied: true, transitionsApplied: true, sfxApplied: true },
}, 'why creators stop growing after a viral reel');
assert(good.ok, `Complete Reel should pass final quality gate: ${good.issues.join('; ')}`);

const bad = finalQuality.audit({
  plan: mockPlan,
  output: { width: 1080, height: 1920, audioPresent: true },
  narration: { narratorProfile: null, metallicApplied: false },
  polish: { captionsApplied: true, safeZoneApplied: false, visualStyle: 'boxed', textBoxes: true, eyeLevelAligned: false, headlineY: 610, subtitleY: 1160 },
  finisher: { applied: false, transitionsApplied: false, sfxApplied: false },
}, 'why creators stop growing after a viral reel');
assert(!bad.ok && bad.issues.length >= 6, 'Dense unfinished Reel must be rejected by final quality gate.');

console.log('ULTRON Reel Finisher self-test passed: intent-aware narrator routing, eye-level boxless typography, cinematic transitions, mandatory Elevate booking close and final production gate validated.');
