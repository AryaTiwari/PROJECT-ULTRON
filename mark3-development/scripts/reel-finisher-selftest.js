const finisher = require('../core/reel-finisher');
const completion = require('../core/reel-completion');
const finalQuality = require('../core/reel-final-quality');
const narrator = require('../core/reel-narrator');

function assert(condition, message) { if (!condition) throw new Error(message); }

assert(finisher.transitionName('clean-cut') === 'fade', 'Clean cuts should map to a subtle fade transition.');
assert(finisher.transitionName('fast-cut') === 'smoothleft', 'Fast cuts should map to a faster directional transition.');
assert(finisher.transitionDuration(3) >= 0.08 && finisher.transitionDuration(3) <= 0.16, 'Transition duration must stay inside the premium short-form range.');
assert(typeof completion.ensureComplete === 'function' && typeof completion.probeDuration === 'function', 'Narration completion guard must be available to the premium runtime.');

const intents = narrator.inferIntent({
  style: 'dark cinematic premium',
  brief: 'why creators stop growing after a viral reel',
  purpose: 'Explain retention, conversion and invite creators to a free strategy session with Elevate OS.',
});
assert(intents.includes('educational') && intents.includes('strategy'), 'Creator strategy narration should infer educational/strategy intent.');
assert(intents.includes('premium') && intents.includes('credible'), 'Elevate business narration should infer premium/credible intent.');

const sceneNarrations = [
  'Virality does not equal loyalty.',
  'Viewers may follow one topic, not you.',
  'Without returns, Instagram sees weaker repeat-viewer signals.',
  'Unrelated follow-ups reset what viewers expect next.',
  'Build three pillars around the winning promise.',
  'Want a growth plan for your account? Book your free Elevate OS strategy session now at elevateos.in.',
];

const mockPlan = {
  durationSec: 20,
  brandPromotion: true,
  cta: 'Book your Free Strategy Session now — Elevate OS — elevateos.in',
  voiceover: sceneNarrations.join(' '),
  narrationTimingPolicy: 'measured-no-cut-v1',
  scenes: [
    { start: 0, end: 2.4, purpose: 'Pattern interrupt', onScreenText: 'Virality ≠ Loyalty', narration: sceneNarrations[0] },
    { start: 2.4, end: 5.7, purpose: 'Context', onScreenText: 'One Topic Won', narration: sceneNarrations[1] },
    { start: 5.7, end: 9.0, purpose: 'Mechanism', onScreenText: 'Return Signals Matter', narration: sceneNarrations[2] },
    { start: 9.0, end: 12.3, purpose: 'Consequence', onScreenText: 'Expectations Reset', narration: sceneNarrations[3] },
    { start: 12.3, end: 16.4, purpose: 'Action', onScreenText: 'Build Repeatable Pillars', narration: sceneNarrations[4] },
    { start: 16.4, end: 20, purpose: 'Brand CTA', onScreenText: 'Book Your Free Strategy Session', subText: 'Elevate OS • elevateos.in', narration: sceneNarrations[5], isBrandCta: true },
  ],
};

const good = finalQuality.audit({
  plan: mockPlan,
  output: { width: 1080, height: 1920, audioPresent: true, durationSec: 20 },
  narration: {
    narratorProfile: 'Verity',
    metallicApplied: false,
    completionVerified: true,
    durationSec: 18.92,
    spokenBudgetSec: 19.35,
    tailRoomSec: 0.65,
    timeFitRate: 1.03,
    completionPolicy: 'finish-before-final-frame-v1',
  },
  completion: {
    verified: true,
    finalNarrationDurationSec: 18.92,
    spokenBudgetSec: 19.35,
    tailRoomSec: 0.65,
    timeFitRate: 1.03,
  },
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
assert(good.narrationCompletionVerified === true, 'Final quality must explicitly confirm narration completion.');

const bad = finalQuality.audit({
  plan: mockPlan,
  output: { width: 1080, height: 1920, audioPresent: true, durationSec: 20 },
  narration: {
    narratorProfile: null,
    metallicApplied: false,
    completionVerified: false,
    durationSec: 20.1,
    spokenBudgetSec: 19.35,
    tailRoomSec: 0,
    timeFitRate: 1.2,
  },
  completion: { verified: false },
  polish: { captionsApplied: true, safeZoneApplied: false, visualStyle: 'boxed', textBoxes: true, eyeLevelAligned: false, headlineY: 610, subtitleY: 1160 },
  finisher: { applied: false, transitionsApplied: false, sfxApplied: false },
}, 'why creators stop growing after a viral reel');
assert(!bad.ok && bad.issues.length >= 9, 'Incomplete or clipped Reel must be rejected by final quality gate.');
assert(bad.issues.some((issue) => /narration.*final frame|spoken-time budget|tail room/i.test(issue)), 'Final quality must explain narration-completion failure.');

console.log('ULTRON Reel Finisher self-test passed: intent-aware narrator routing, measured no-cut narration, eye-level boxless typography, cinematic transitions, mandatory Elevate booking close and final production gate validated.');
