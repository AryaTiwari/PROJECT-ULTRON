const learning = require('../core/reel-learning');
const instagram = require('../core/instagram');
const performance = require('../core/reel-performance');

function assert(condition, message) { if (!condition) throw new Error(message); }

const recipe = learning.recipeFromResult({
  ok: true,
  job: { id: 'test-reel-learning', brief: 'creator growth explainer', finalQuality: { score: 100 } },
  plan: {
    durationSec: 20,
    style: 'premium educational',
    brandPromotion: true,
    intelligence: {
      selectedFormats: ['pattern-analysis explainer'],
      trendMode: 'live-research',
      completedSources: ['hootsuite', 'general'],
      aestheticTags: ['dark', 'muted'],
      palette: [{ hex: '#20242A' }],
    },
    scenes: [
      { onScreenText: 'Viral Is Not Growth' },
      { onScreenText: 'Reach Must Convert' },
      { onScreenText: 'Build Repeatable Pillars' },
      { onScreenText: 'Free Strategy Session', isBrandCta: true },
    ],
  },
  narration: { narratorProfile: 'Verity' },
  polish: { visualStyle: 'minimal-clean-v3', textBoxes: false, musicApplied: false },
  finisher: { transitionsApplied: true, transitionCount: 3, sfxApplied: true },
  output: { path: 'test.mp4', durationSec: 20 },
});

assert(recipe.selectedFormats.includes('pattern-analysis explainer'), 'Creative recipe must retain selected Reel format intelligence.');
assert(recipe.trendSources.includes('hootsuite'), 'Creative recipe must retain verified trend-source provenance.');
assert(recipe.narrator === 'Verity', 'Creative recipe must retain narrator choice.');
assert(recipe.textBoxes === false, 'Creative recipe must distinguish boxless typography.');
assert(recipe.averageHeadlineWords > 0 && recipe.maxHeadlineWords <= 4, 'Creative recipe must measure on-screen text density.');
assert(learning.feedbackScore('the Reel text is too much and looks unfinished') < 0, 'Negative Reel feedback must score negatively.');
assert(learning.feedbackScore('this video is clean and polished, keep it') > 0, 'Positive Reel feedback must score positively.');
assert(learning.isReelFeedback('the captions are too cluttered and ugly'), 'Plural caption feedback must be recognized as Reel feedback.');
assert(learning.isReelFeedback('the subtitles are too crowded and hard to read'), 'Plural subtitle feedback must be recognized as Reel feedback.');
assert(learning.isReelFeedback('the narrator voice sounds bad for this reel'), 'Narrator/voice feedback must be recognized as Reel feedback.');
assert(!learning.isReelFeedback('remind me to call the client tomorrow'), 'Unrelated commands must not enter Reel creative learning.');
assert(learning.scoreOutcome({ reach: 1000, likes: 80, comments: 10, saves: 20, shares: 15, follows: 12 }) > 0, 'Strong performance metrics must produce positive creative outcome score.');

const normalized = instagram.normalizeInsightMetrics({ views: 5000, reach: 3200, likes: 240, comments: 19, shares: 52, saved: 71, total_interactions: 382, ig_reels_avg_watch_time: 8300 });
assert(normalized.views === 5000 && normalized.saves === 71, 'Instagram insight metrics must normalize current API field names.');
assert(normalized.averageWatchTimeMs === 8300, 'Average Reel watch time must survive insights normalization.');
assert(instagram.status().mediaInsightsImplemented === true, 'Instagram connector must expose media insights capability.');

const status = learning.status();
const performanceStatus = performance.status();
assert(status.outcomeLearningImplemented === true && status.structuredAdaptiveLearning === true, 'Reel learning must support feedback and outcome-based adaptation.');
assert(performanceStatus.closedLoopLearning === true, 'Published Reel links must support closed-loop Instagram performance learning.');
assert(performanceStatus.insightsPermissionRequired === 'instagram_business_manage_insights', 'Insights permission requirement must remain explicit.');

console.log('ULTRON Reel Learning self-test passed: creative recipes, plural feedback language, Hootsuite provenance, Instagram insights and performance-outcome learning validated.');
