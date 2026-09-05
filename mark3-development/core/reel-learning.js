const fs = require('fs');
const path = require('path');
const config = require('./config');
const adaptive = require('./adaptive-intelligence');
const { readJson, writeJsonAtomic } = require('./persistence');

const ROOT = path.resolve(config.projectRoot, '.ultron', 'reels');
const LEARNING_PATH = path.join(ROOT, 'creative-learning.json');
const MAX_RENDERS = 120;
const MAX_FEEDBACK = 240;

function empty() {
  return {
    version: 1,
    updatedAt: null,
    renders: [],
    feedback: [],
    formatWeights: {},
    narratorWeights: {},
    styleWeights: {},
  };
}
function load() { return readJson(LEARNING_PATH, empty()); }
function save(data) { data.updatedAt = new Date().toISOString(); writeJsonAtomic(LEARNING_PATH, data); return data; }
function clean(value, max = 160) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function average(values = []) {
  const numbers = values.map(Number).filter(Number.isFinite);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : 0;
}
function textWords(value) { return clean(value, 1000).split(/\s+/).filter(Boolean).length; }

function recipeFromResult(result = {}) {
  const plan = result.plan || {};
  const job = result.job || {};
  const polish = result.polish || job.polish || {};
  const finisher = result.finisher || job.finisher || {};
  const narration = result.narration || job.narration || {};
  const scenes = Array.isArray(plan.scenes) ? plan.scenes : [];
  const headlines = scenes.filter((scene) => !scene.isBrandCta).map((scene) => textWords(scene.onScreenText));
  return {
    jobId: job.id || path.basename(result?.paths?.dir || '') || null,
    createdAt: new Date().toISOString(),
    brief: clean(job.brief || plan.title, 300),
    durationSec: Number(plan.durationSec || result?.output?.durationSec || 0) || null,
    selectedFormats: Array.isArray(plan?.intelligence?.selectedFormats) ? plan.intelligence.selectedFormats.slice(0, 5) : [],
    trendMode: plan?.intelligence?.trendMode || null,
    trendSources: Array.isArray(plan?.intelligence?.completedSources) ? plan.intelligence.completedSources.slice(0, 8) : [],
    aestheticTags: Array.isArray(plan?.intelligence?.aestheticTags) ? plan.intelligence.aestheticTags.slice(0, 8) : [],
    palette: Array.isArray(plan?.intelligence?.palette) ? plan.intelligence.palette.slice(0, 5) : [],
    style: clean(plan.style, 600),
    narrator: clean(narration.narratorProfile || narration.narratorProfileId, 100) || null,
    sceneCount: scenes.length,
    averageHeadlineWords: Number(average(headlines).toFixed(2)),
    maxHeadlineWords: headlines.length ? Math.max(...headlines) : 0,
    captionsStyle: polish.visualStyle || null,
    textBoxes: Boolean(polish.textBoxes),
    transitionsApplied: Boolean(finisher.transitionsApplied),
    transitionCount: Number(finisher.transitionCount || 0),
    sfxApplied: Boolean(finisher.sfxApplied),
    musicApplied: Boolean(polish.musicApplied),
    brandPromotion: Boolean(plan.brandPromotion),
    finalQualityScore: Number(job?.finalQuality?.score || result?.finalQuality?.score || 0) || null,
    outputPath: result?.output?.path || null,
    userScore: 0,
    feedbackCount: 0,
  };
}

function recordRender(result = {}) {
  if (!result?.ok) return null;
  const recipe = recipeFromResult(result);
  if (!recipe.jobId) return null;
  const data = load();
  data.renders = [recipe, ...(data.renders || []).filter((item) => item.jobId !== recipe.jobId)].slice(0, MAX_RENDERS);
  save(data);
  return recipe;
}

function latestRender() { return (load().renders || [])[0] || null; }
function feedbackScore(text = '') {
  const polarity = adaptive.feedbackPolarity(text);
  if (polarity !== null) return polarity;
  const value = String(text || '').toLowerCase();
  if (/\b(?:great|good|nice|clean|polished|professional|love it|keep it)\b/.test(value)) return 1;
  if (/\b(?:bad|ugly|poor|unfinished|messy|cluttered|overdone|wrong|hate it)\b/.test(value)) return -1;
  return 0;
}

function isReelFeedback(text = '') {
  const value = String(text || '');
  const reel = /\b(?:reel|video|edit|caption|text|subtitle|graphics?|effects?|transition|narrator|voice|b-roll|broll|cta)\b/i.test(value);
  const feedback = adaptive.isExplicitPreference(value) || /\b(?:good|great|better|worse|bad|ugly|unfinished|messy|clean|polished|professional|cluttered|overdone)\b/i.test(value);
  return reel && feedback;
}

function bumpWeight(map, key, score) {
  if (!key) return;
  const current = Number(map[key] || 0);
  map[key] = Number(Math.max(-12, Math.min(12, current + score)).toFixed(2));
}

function publishStructuredLearning(render, score, explicit) {
  if (!render || !score) return;
  const direction = score > 0 ? 'prefer' : 'avoid';
  const confidence = explicit ? 0.84 : 0.68;
  for (const format of render.selectedFormats || []) {
    adaptive.recordSignal({
      domain: 'creator-content',
      text: `Creative recipe feedback: ${direction} Reel format "${format}" based on feedback to job ${render.jobId}.`,
      polarity: score > 0 ? 1 : -1,
      explicit: false,
      confidence,
    }, { source: 'reel-creative-learning' });
  }
  if (render.captionsStyle) {
    adaptive.recordSignal({
      domain: 'creator-content',
      text: `Creative recipe feedback: ${direction} caption style "${render.captionsStyle}" for Reels.`,
      polarity: score > 0 ? 1 : -1,
      explicit: false,
      confidence,
    }, { source: 'reel-creative-learning' });
  }
  adaptive.recordSignal({
    domain: 'creator-content',
    text: `Creative recipe feedback: ${direction} ${render.textBoxes ? 'boxed/translucent text containers' : 'boxless text treatment'} for Reels.`,
    polarity: score > 0 ? 1 : -1,
    explicit: false,
    confidence,
  }, { source: 'reel-creative-learning' });
  if (render.narrator) {
    adaptive.recordSignal({
      domain: 'creator-content',
      text: `Creative recipe feedback: ${direction} narrator profile "${render.narrator}" for similar Reels.`,
      polarity: score > 0 ? 1 : -1,
      explicit: false,
      confidence: Math.max(0.55, confidence - 0.08),
    }, { source: 'reel-creative-learning' });
  }
}

function recordFeedback(text = '', options = {}) {
  if (!isReelFeedback(text)) return null;
  const data = load();
  const render = options.jobId
    ? (data.renders || []).find((item) => item.jobId === options.jobId)
    : (data.renders || [])[0];
  if (!render) return null;
  const score = feedbackScore(text);
  const feedback = {
    id: `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    jobId: render.jobId,
    score,
    text: clean(text, 500),
    explicit: adaptive.isExplicitPreference(text),
  };
  data.feedback = [feedback, ...(data.feedback || [])].slice(0, MAX_FEEDBACK);
  render.feedbackCount = Number(render.feedbackCount || 0) + 1;
  render.userScore = Math.max(-12, Math.min(12, Number(render.userScore || 0) + score));
  const strength = feedback.explicit ? score * 1.5 : score;
  for (const format of render.selectedFormats || []) bumpWeight(data.formatWeights, format, strength);
  if (render.narrator) bumpWeight(data.narratorWeights, render.narrator, strength);
  if (render.captionsStyle) bumpWeight(data.styleWeights, `captions:${render.captionsStyle}`, strength);
  bumpWeight(data.styleWeights, render.textBoxes ? 'text-boxes' : 'boxless-text', strength);
  bumpWeight(data.styleWeights, render.sfxApplied ? 'sfx' : 'no-sfx', strength * 0.5);
  bumpWeight(data.styleWeights, render.transitionsApplied ? 'transitions' : 'hard-cuts', strength * 0.5);
  save(data);
  publishStructuredLearning(render, score, feedback.explicit);
  return { feedback, render: { jobId: render.jobId, brief: render.brief, userScore: render.userScore } };
}

function scoreOutcome(metrics = {}) {
  const views = Number(metrics.views || metrics.plays || 0);
  const reach = Number(metrics.reach || 0);
  const likes = Number(metrics.likes || 0);
  const comments = Number(metrics.comments || 0);
  const saves = Number(metrics.saves || 0);
  const shares = Number(metrics.shares || 0);
  const follows = Number(metrics.follows || metrics.followersGained || 0);
  const base = Math.max(1, reach || views || 1);
  const engagement = (likes + comments * 2 + saves * 3 + shares * 3) / base;
  const conversion = follows / base;
  return Number(Math.max(-3, Math.min(3, engagement * 18 + conversion * 80)).toFixed(3));
}

function recordOutcome(jobId, metrics = {}) {
  const data = load();
  const render = (data.renders || []).find((item) => item.jobId === jobId);
  if (!render) return null;
  const score = scoreOutcome(metrics);
  render.performance = { metrics, score, recordedAt: new Date().toISOString() };
  const strength = Math.max(-2, Math.min(2, score));
  for (const format of render.selectedFormats || []) bumpWeight(data.formatWeights, format, strength);
  if (render.narrator) bumpWeight(data.narratorWeights, render.narrator, strength * 0.5);
  save(data);
  if (Math.abs(strength) >= 0.35) publishStructuredLearning(render, strength > 0 ? 1 : -1, false);
  return { jobId, score, metrics };
}

function preferences() {
  const data = load();
  const ranked = (object = {}) => Object.entries(object).sort((a, b) => b[1] - a[1]);
  return {
    formatWeights: ranked(data.formatWeights),
    narratorWeights: ranked(data.narratorWeights),
    styleWeights: ranked(data.styleWeights),
    recentFeedback: (data.feedback || []).slice(0, 8),
  };
}

function context() {
  const prefs = preferences();
  const preferredFormats = prefs.formatWeights.filter(([, score]) => score > 0).slice(0, 4);
  const avoidFormats = [...prefs.formatWeights].reverse().filter(([, score]) => score < 0).slice(0, 4);
  const preferredStyles = prefs.styleWeights.filter(([, score]) => score > 0).slice(0, 5);
  const avoidStyles = [...prefs.styleWeights].reverse().filter(([, score]) => score < 0).slice(0, 5);
  return {
    available: Boolean(preferredFormats.length || avoidFormats.length || preferredStyles.length || avoidStyles.length),
    preferredFormats,
    avoidFormats,
    preferredStyles,
    avoidStyles,
    recentFeedback: prefs.recentFeedback.slice(0, 4),
  };
}

function status() {
  const data = load();
  return {
    implemented: true,
    rendersTracked: (data.renders || []).length,
    feedbackTracked: (data.feedback || []).length,
    outcomeLearningImplemented: true,
    structuredAdaptiveLearning: true,
    path: LEARNING_PATH,
  };
}

module.exports = { LEARNING_PATH, recipeFromResult, recordRender, latestRender, feedbackScore, isReelFeedback, publishStructuredLearning, recordFeedback, scoreOutcome, recordOutcome, preferences, context, status };
