const fs = require('fs');
const path = require('path');
const config = require('./config');
const researchAgent = require('./research-agent');
const integrations = require('./integrations');
const aesthetic = require('./instagram-aesthetic');
const adaptive = require('./adaptive-intelligence');
const { readJson, writeJsonAtomic } = require('./persistence');

const ROOT = path.resolve(config.projectRoot, '.ultron', 'reels');
const INTEL_PATH = path.join(ROOT, 'reel-intelligence.json');
const TREND_TTL_MS = Math.max(60 * 60 * 1000, Number(process.env.ULTRON_M3_REEL_TREND_TTL_MS || 12 * 60 * 60 * 1000));
const AESTHETIC_TTL_MS = Math.max(60 * 60 * 1000, Number(process.env.ULTRON_M3_REEL_AESTHETIC_TTL_MS || 24 * 60 * 60 * 1000));

const REFERENCES = [
  { id: 'hootsuite-tracker', title: 'Hootsuite Trend Analysis Tool', url: 'https://www.hootsuite.com/trend-analysis-tool', role: 'real-time trend momentum and conversation signal' },
  { id: 'hootsuite-2026-trends', title: 'Hootsuite Social Media Trends 2026', url: 'https://www.hootsuite.com/research/social-trends', role: 'macro social behavior and creative strategy reference' },
  { id: 'hootsuite-reels-2026', title: 'Hootsuite Instagram Reels for business in 2026', url: 'https://blog.hootsuite.com/instagram-reels/', role: 'Reels format and platform best-practice reference' },
];

const FALLBACK_PATTERNS = [
  {
    name: 'micro-drama / serialized payoff',
    hookPattern: 'open mid-conflict or with an unresolved tension in the first 1–2 seconds',
    structure: 'hook → escalating micro-story → reveal/payoff → next-step CTA',
    editing: 'quick scene progression, purposeful text only, natural pacing rather than over-editing',
    bestFor: ['storytelling', 'creator growth', 'case studies', 'before-after'],
  },
  {
    name: 'pattern-analysis explainer',
    hookPattern: 'counterintuitive claim or visible data point',
    structure: 'claim → mechanism → proof/example → actionable rule',
    editing: 'clean data-led graphics, sparse labels, B-roll tied to each mechanism',
    bestFor: ['educational', 'strategy', 'metrics', 'business'],
  },
  {
    name: 'rapid-response cultural angle',
    hookPattern: 'connect a current moment to the audience problem immediately',
    structure: 'current signal → relevance → creator-specific angle → execution suggestion',
    editing: 'fast but authentic, low-friction visuals, minimal template feel',
    bestFor: ['trends', 'timely takes', 'news-reactive creator content'],
  },
  {
    name: 'human-authentic authority',
    hookPattern: 'direct human observation, confession, mistake or strong opinion',
    structure: 'real observation → lesson → specific example → practical takeaway',
    editing: 'natural cadence, imperfect human texture, restrained effects',
    bestFor: ['founder content', 'trust', 'personal brand', 'advice'],
  },
  {
    name: 'search-first answer reel',
    hookPattern: 'state the exact question/problem people search for',
    structure: 'question → concise answer → 2–3 supporting points → CTA/save prompt',
    editing: 'clear visual labeling, readable keywords, no decorative text overload',
    bestFor: ['SEO/discovery', 'tutorials', 'how-to', 'FAQ'],
  },
];

function ensureRoot() { fs.mkdirSync(ROOT, { recursive: true }); }
function load() { ensureRoot(); return readJson(INTEL_PATH, null); }
function save(data) { ensureRoot(); writeJsonAtomic(INTEL_PATH, data); return data; }
function stale(value = load()) { return !value?.updatedAt || Date.now() - Date.parse(value.updatedAt) > TREND_TTL_MS; }
function textFromModel(result) {
  const value = result?.content ?? result?.response ?? result?.text ?? result?.choices?.[0]?.message?.content ?? result?.raw?.choices?.[0]?.message?.content ?? '';
  return typeof value === 'string' ? value.trim() : String(value || '').trim();
}
function parseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Reel Intelligence synthesis returned empty output.');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || raw;
  try { return JSON.parse(fenced); } catch {}
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(fenced.slice(start, end + 1));
  throw new Error('Reel Intelligence synthesis returned invalid JSON.');
}

function evidenceText(evidence) {
  const blocks = [];
  for (const result of (evidence?.results || []).slice(0, 8)) {
    blocks.push(`${result.title || ''}\n${result.snippet || ''}\n${result.url || ''}`);
  }
  for (const page of (evidence?.pages || []).filter((item) => item?.text).slice(0, 5)) {
    blocks.push(`${page.title || ''}\n${String(page.text).slice(0, 6500)}\nSOURCE=${page.url || ''}`);
  }
  return blocks.join('\n\n---\n\n').slice(0, 26000);
}

async function synthesizeTrendFormats(evidence) {
  const completed = evidence?.researchReceipt?.completedSources || evidence?.research?.completedSources || [];
  const requested = evidence?.researchReceipt?.requestedSources || evidence?.research?.requestedSources || [];
  const prompt = [
    'You are ULTRON Reel Intelligence, a senior short-form strategist and social video editor.',
    'Turn the supplied current research into reusable Instagram Reel FORMAT intelligence. Return JSON only.',
    'Do not invent a Hootsuite claim unless Hootsuite appears in completedSources. Treat trend signals as directional, not guarantees.',
    `requestedSources=${JSON.stringify(requested)}`,
    `completedSources=${JSON.stringify(completed)}`,
    'For each format, describe the structure and editing grammar, not just a topic. Focus on hooks, pacing, text density, graphics, B-roll, effects, authenticity, search/discovery and CTA behavior.',
    'JSON schema: {"marketSignals":[""],"formats":[{"name":"","whyNow":"","hookPattern":"","structure":"","textRule":"","graphicsRule":"","effectsRule":"","pacing":"","bestFor":[""],"avoid":[""]}],"principles":[""],"confidence":0.0}',
    'CURRENT RESEARCH:',
    evidenceText(evidence),
  ].join('\n');
  const result = await integrations.chat([
    { role: 'system', content: 'Produce grounded, current, practical social-video intelligence. JSON only.' },
    { role: 'user', content: prompt },
  ], 'auto/best-reasoning', null, { taskType: 'planning' });
  return parseJson(textFromModel(result));
}

async function refreshTrends(options = {}) {
  ensureRoot();
  const task = {
    kind: 'content-trends',
    original: 'Refresh Reel Intelligence using Hootsuite and current web evidence.',
    query: [
      'current Instagram Reels and short-form video FORMAT trends for creators in 2026',
      'prioritize Hootsuite public trend-analysis and Instagram Reels guidance as a directional reference',
      'cross-check with broader current web evidence',
      'look specifically for hook structures, micro-drama, educational explainers, creator authenticity, text/graphics patterns, editing pace, search-first discovery, rapid-response formats and current audience behavior',
    ].join('; '),
    resumed: false,
  };

  try {
    const evidence = await researchAgent.run(task, { searchLimit: options.searchLimit || 7, fetchTop: 4, specializedFetchTop: 3, maxMergedResults: 16, maxMergedPages: 8 });
    const synthesis = await synthesizeTrendFormats(evidence);
    const data = {
      version: 1,
      updatedAt: new Date().toISOString(),
      mode: 'live-research',
      requestedSources: evidence?.researchReceipt?.requestedSources || [],
      completedSources: evidence?.researchReceipt?.completedSources || [],
      sourceErrors: evidence?.researchReceipt?.errors || [],
      references: REFERENCES,
      marketSignals: Array.isArray(synthesis.marketSignals) ? synthesis.marketSignals.slice(0, 12) : [],
      formats: Array.isArray(synthesis.formats) && synthesis.formats.length ? synthesis.formats.slice(0, 12) : FALLBACK_PATTERNS,
      principles: Array.isArray(synthesis.principles) ? synthesis.principles.slice(0, 12) : [],
      confidence: Number.isFinite(Number(synthesis.confidence)) ? Number(synthesis.confidence) : 0.65,
      researchReceipt: evidence?.researchReceipt || null,
    };
    return save(data);
  } catch (error) {
    const prior = load();
    const data = {
      version: 1,
      updatedAt: new Date().toISOString(),
      mode: prior?.formats?.length ? 'cached-fallback' : 'built-in-reference-fallback',
      requestedSources: prior?.requestedSources || ['hootsuite', 'general'],
      completedSources: prior?.completedSources || [],
      sourceErrors: [{ source: 'trend-refresh', error: error.message }],
      references: REFERENCES,
      marketSignals: prior?.marketSignals || [
        'Creative pattern analytics should drive rapid iteration rather than one fixed formula.',
        'Authenticity and human texture matter even when AI supports the workflow.',
        'Short-form discovery increasingly rewards search-friendly, audience-specific usefulness.',
        'Fast response to cultural moments can outperform rigid calendars when the angle fits the audience.',
      ],
      formats: prior?.formats || FALLBACK_PATTERNS,
      principles: prior?.principles || [
        'Use AI to accelerate production, not to make content feel synthetic.',
        'Treat trends as format signals to adapt to the account, not templates to copy blindly.',
        'Prefer audience alignment and repeatable creative patterns over vanity metrics alone.',
      ],
      confidence: prior?.confidence || 0.5,
      refreshError: error.message,
    };
    return save(data);
  }
}

function formatScore(format, brief = '', style = '') {
  const source = `${brief} ${style}`.toLowerCase();
  const tokens = new Set(source.split(/[^a-z0-9]+/).filter(Boolean));
  const haystack = `${format.name || ''} ${(format.bestFor || []).join(' ')} ${format.hookPattern || ''}`.toLowerCase();
  let score = 0;
  for (const token of tokens) if (token.length > 3 && haystack.includes(token)) score += 1;
  if (/why|how|strategy|growth|metrics|analytics|explain|educational/.test(source) && /explain|pattern|search|authority|data/.test(haystack)) score += 4;
  if (/story|case study|journey|before|after/.test(source) && /drama|story|authority/.test(haystack)) score += 4;
  if (/trend|viral|news|current|today/.test(source) && /rapid|cultural|trend/.test(haystack)) score += 4;
  return score;
}

function selectFormats(intel, brief, style, limit = 3) {
  const formats = Array.isArray(intel?.formats) && intel.formats.length ? intel.formats : FALLBACK_PATTERNS;
  return formats.map((format, index) => ({ format, score: formatScore(format, brief, style), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((row) => row.format);
}

async function ensureAesthetic(options = {}) {
  const current = aesthetic.latest();
  const old = !current?.capturedAt || Date.now() - Date.parse(current.capturedAt) > AESTHETIC_TTL_MS;
  if (!old && !options.force) return current;
  try { return await aesthetic.analyze({ limit: 10 }); }
  catch { return current || null; }
}

async function contextFor(brief = '', style = '', options = {}) {
  let intel = load();
  if (!intel || stale(intel) || options.forceTrendRefresh) intel = await refreshTrends(options);
  const accountAesthetic = await ensureAesthetic({ force: options.forceAestheticRefresh });
  const learned = adaptive.contextFor('creator-content', 6);
  const designLearned = adaptive.contextFor('design', 4);
  const selected = selectFormats(intel, brief, style, 3);
  const sourceTruth = `trend mode=${intel?.mode || 'unknown'}; Hootsuite ${Array.isArray(intel?.completedSources) && intel.completedSources.includes('hootsuite') ? 'completed' : 'not verified in latest run'}`;
  const context = [
    `REEL INTELLIGENCE SOURCE TRUTH: ${sourceTruth}.`,
    `FORMAT OPTIONS: ${selected.map((f) => `${f.name}: hook=${f.hookPattern || ''}; structure=${f.structure || ''}; text=${f.textRule || ''}; graphics=${f.graphicsRule || ''}; effects=${f.effectsRule || ''}; pace=${f.pacing || ''}`).join(' || ')}`,
    accountAesthetic ? `ACCOUNT AESTHETIC: ${aesthetic.summary(accountAesthetic)}` : 'ACCOUNT AESTHETIC: unavailable; do not invent one.',
    learned.available ? `LEARNED CREATOR-CONTENT PREFERENCES: ${learned.summary}` : 'LEARNED CREATOR-CONTENT PREFERENCES: none yet.',
    designLearned.available ? `LEARNED DESIGN PREFERENCES: ${designLearned.summary}` : '',
    'RULE: Adapt a current format to the account. Never copy a trend blindly. Prefer sparse intentional text, account-fit visuals and audience usefulness. Preserve an authentic human feel even when AI builds the asset.',
  ].filter(Boolean).join('\n').slice(0, 4200);
  return { intelligence: intel, aesthetic: accountAesthetic, adaptive: { creator: learned, design: designLearned }, selectedFormats: selected, context };
}

function enrichedStyle(style = '', intelligenceContext = '') {
  const base = String(style || 'cinematic, fast-paced, premium creator reel').trim();
  return `${base}. CREATIVE INTELLIGENCE: ${String(intelligenceContext || '').replace(/\s+/g, ' ').slice(0, 3200)}`;
}

async function suggestIdeas(options = {}) {
  const topic = String(options.topic || 'creator growth and Elevate OS').trim();
  const ctx = await contextFor(topic, options.style || 'premium creator content', options);
  const prompt = [
    'You are ULTRON Social Media Analyst. Generate high-fit Reel ideas for this specific Instagram account.',
    'Use trend formats only when they fit the account aesthetic and learned preferences. Ideas must be executable, not generic.',
    `ACCOUNT + TREND INTELLIGENCE:\n${ctx.context}`,
    `FOCUS: ${topic}`,
    'Return JSON only: {"ideas":[{"title":"","hook":"","format":"","whyFit":"","execution":"","cta":"","confidence":0.0}]}',
  ].join('\n\n');
  const result = await integrations.chat([
    { role: 'system', content: 'Act as a current, evidence-aware Instagram strategist. JSON only.' },
    { role: 'user', content: prompt },
  ], 'auto/best-reasoning', null, { taskType: 'planning' });
  const parsed = parseJson(textFromModel(result));
  return { ...ctx, ideas: Array.isArray(parsed.ideas) ? parsed.ideas.slice(0, Math.max(3, Math.min(10, Number(options.limit || 6)))) : [] };
}

function status() {
  const intel = load();
  return {
    implemented: true,
    trendIntelAvailable: Boolean(intel),
    trendIntelStale: stale(intel),
    trendMode: intel?.mode || null,
    completedSources: intel?.completedSources || [],
    references: REFERENCES,
    aesthetic: aesthetic.status(),
    adaptive: adaptive.status(),
    cachePath: INTEL_PATH,
  };
}

module.exports = { ROOT, INTEL_PATH, REFERENCES, FALLBACK_PATTERNS, stale, load, refreshTrends, selectFormats, contextFor, enrichedStyle, suggestIdeas, status };
