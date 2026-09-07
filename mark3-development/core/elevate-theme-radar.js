const intelligence = require('./reel-intelligence');

const THEMES = Object.freeze([
  {
    id: 'views-to-followers',
    title: 'Views without follower conversion',
    pillar: 'conversion',
    hook: 'Your views are growing. Your audience is not.',
    keywords: ['conversion', 'profile', 'follower', 'analytics', 'search', 'educational', 'growth'],
  },
  {
    id: 'retention-leaks',
    title: 'Retention and skip-rate leaks',
    pillar: 'growth-retention',
    hook: 'Your Reel may be losing people before your value even starts.',
    keywords: ['retention', 'hook', 'pacing', 'micro-drama', 'watch', 'short-form', 'reel'],
  },
  {
    id: 'creator-positioning',
    title: 'Creator positioning that makes the account memorable',
    pillar: 'positioning',
    hook: 'Good content is forgettable when the creator promise is unclear.',
    keywords: ['authenticity', 'authority', 'human', 'account', 'audience', 'creator', 'identity'],
  },
  {
    id: 'repeatable-content-system',
    title: 'Repeatable content systems instead of random posting',
    pillar: 'content-system',
    hook: 'Posting more cannot fix a content system that has no pattern.',
    keywords: ['pattern', 'series', 'format', 'repeatable', 'creative', 'content', 'iteration'],
  },
  {
    id: 'brand-readiness',
    title: 'Brand readiness and creator monetization',
    pillar: 'monetization',
    hook: 'Brands do not pay for follower count alone.',
    keywords: ['brand', 'business', 'monetization', 'trust', 'authority', 'audience', 'creator'],
  },
  {
    id: 'search-discovery',
    title: 'Search-first creator discovery',
    pillar: 'growth-retention',
    hook: 'The next follower may be searching for your exact answer.',
    keywords: ['search', 'discovery', 'seo', 'question', 'answer', 'usefulness', 'tutorial'],
  },
  {
    id: 'human-ai-content',
    title: 'Human-feeling content in an AI-heavy feed',
    pillar: 'positioning',
    hook: 'AI can speed up content without making the creator feel synthetic.',
    keywords: ['authenticity', 'human', 'ai', 'synthetic', 'creator', 'trust', 'texture'],
  },
]);

function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }

function sourceText(intel = {}) {
  const formats = Array.isArray(intel.formats) ? intel.formats : [];
  return [
    ...(intel.marketSignals || []),
    ...(intel.principles || []),
    ...formats.flatMap((format) => [format.name, format.whyNow, format.hookPattern, format.structure, ...(format.bestFor || [])]),
  ].filter(Boolean).join(' ').toLowerCase();
}

function briefPillarHint(brief = '') {
  const text = clean(brief).toLowerCase();
  if (/\b(?:brand|moneti[sz]|sponsor|income|revenue|collab|ugc)\b/.test(text)) return 'monetization';
  if (/\b(?:position|authority|niche|identity|personal brand)\b/.test(text)) return 'positioning';
  if (/\b(?:conversion|profile visit|follow conversion|cta|lead|click)\b/.test(text)) return 'conversion';
  if (/\b(?:system|pillar|consisten|calendar|workflow|series|posting)\b/.test(text)) return 'content-system';
  return /\b(?:retention|skip|views?|reach|followers?|growth|viral|watch)\b/.test(text) ? 'growth-retention' : null;
}

function scoreTheme(theme, intelText, brief = '') {
  let score = 42;
  const hits = theme.keywords.filter((keyword) => intelText.includes(keyword)).length;
  score += Math.min(35, hits * 7);
  const hint = briefPillarHint(brief);
  if (hint && hint === theme.pillar) score += 14;
  const briefText = clean(brief).toLowerCase();
  if (theme.keywords.some((keyword) => briefText.includes(keyword))) score += 8;
  return Math.max(0, Math.min(96, score));
}

function snapshot(brief = '', value = intelligence.load()) {
  const intel = value || {};
  const text = sourceText(intel);
  const ranked = THEMES.map((theme, index) => ({
    ...theme,
    momentumScore: scoreTheme(theme, text, brief),
    index,
  })).sort((a, b) => b.momentumScore - a.momentumScore || a.index - b.index)
    .slice(0, 5)
    .map(({ index, keywords, ...theme }) => theme);

  return {
    implemented: true,
    market: 'creator economy / Instagram Reels',
    brand: 'Elevate OS',
    generatedAt: new Date().toISOString(),
    intelligenceUpdatedAt: intel.updatedAt || null,
    trendMode: intel.mode || 'built-in-fallback',
    completedSources: Array.isArray(intel.completedSources) ? intel.completedSources : [],
    themes: ranked,
    topTheme: ranked[0] || null,
    scoring: 'current Reel Intelligence signals + Elevate pillar fit',
    directionalOnly: true,
    guaranteesVirality: false,
  };
}

function status() {
  const latest = snapshot('');
  return {
    implemented: true,
    candidateThemes: THEMES.length,
    latestTopTheme: latest.topTheme?.title || null,
    intelligenceUpdatedAt: latest.intelligenceUpdatedAt,
    trendMode: latest.trendMode,
    directionalOnly: true,
    guaranteesVirality: false,
  };
}

module.exports = { THEMES, clean, sourceText, briefPillarHint, scoreTheme, snapshot, status };
