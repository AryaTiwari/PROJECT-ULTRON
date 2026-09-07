const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('./config');
const integrations = require('./integrations');
const sources = require('./reel-sources');
const quality = require('./reel-quality');
const narrator = require('./reel-narrator');
const { writeJsonAtomic } = require('./persistence');

const REEL_ROOT = path.resolve(config.projectRoot, '.ultron', 'reels');

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function slug(value) {
  return String(value || 'reel')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42) || 'reel';
}

function reelId(brief) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${stamp}-${slug(brief)}`;
}

function ffmpegStatus() {
  try {
    const result = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const text = String(result.stdout || result.stderr || '');
    return {
      available: result.status === 0 && /ffmpeg version/i.test(text),
      binary: 'ffmpeg',
      firstLine: text.split(/\r?\n/)[0] || null,
    };
  } catch (error) {
    return { available: false, binary: 'ffmpeg', firstLine: null, error: error.message };
  }
}

function extractText(result) {
  if (typeof result === 'string') return result;
  if (typeof result?.response === 'string') return result.response;
  if (typeof result?.text === 'string') return result.text;
  if (typeof result?.content === 'string') return result.content;
  if (typeof result?.message?.content === 'string') return result.message.content;
  const choice = result?.choices?.[0]?.message?.content ?? result?.choices?.[0]?.text;
  if (typeof choice === 'string') return choice;
  if (Array.isArray(choice)) return choice.map((part) => part?.text || part?.content || '').join('\n');
  return '';
}

function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Reel Director returned an empty response.');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced || raw).trim();
  try { return JSON.parse(candidate); } catch {}
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
  throw new Error('Reel Director did not return valid JSON.');
}

function fallbackPlan(brief, options = {}) {
  const durationSec = clamp(options.durationSec, 15, 60, 30);
  const cleanBrief = String(brief || '').trim() || 'why creators struggle to turn reach into repeatable growth';
  const req = quality.requirements(durationSec);
  const creatorTopic = quality.creatorGrowthBrief(cleanBrief);
  const base = creatorTopic ? [
    ['Pattern interrupt', 'Virality ≠ Loyalty', 'Virality does not equal loyalty.', 'content creator reviewing viral post and profile performance on smartphone vertical video'],
    ['Context', 'One Topic Won', 'Viewers may follow one topic, not you.', 'content creator checking recent post and profile on smartphone vertical video'],
    ['Mechanism', 'Return Signals Matter', 'Without returns, Instagram sees weaker repeat-viewer signals.', 'content creator checking social media analytics on smartphone in modern workspace vertical video'],
    ['Consequence', 'Expectations Reset', 'Unrelated follow-ups reset what viewers expect next.', 'content creator reviewing several different posts on smartphone vertical video'],
    ['Action', 'Build Repeatable Pillars', 'Build three pillars around the winning promise.', 'content creator planning content calendar with notebook and laptop in modern workspace vertical video'],
    ['Brand CTA', 'Book Your Free Strategy Session', 'Want a growth plan built around your account? Book your free strategy session with Elevate OS now at elevateos.in.', 'content creator strategy consultation modern premium workspace vertical video'],
  ] : [
    ['Pattern interrupt', 'Look Beyond The Result', 'Results hide the system behind them.', `${cleanBrief} practical real-world vertical video`],
    ['Context', 'Find The Real Cause', 'Separate the visible symptom from its real cause.', `${cleanBrief} person analyzing problem vertical video`],
    ['Mechanism', 'Look For The Pattern', 'Repeated outcomes reveal patterns one result cannot.', `${cleanBrief} person reviewing notes or data vertical video`],
    ['Consequence', 'Fix The Bottleneck', 'Fix the bottleneck that changes the outcome most.', `${cleanBrief} focused work vertical video`],
    ['Action', 'Build A Repeatable System', 'Turn that insight into a measurable process.', `${cleanBrief} planning workflow vertical video`],
    ['Payoff', 'Use Systems, Not Luck', 'Use repeatable systems instead of isolated wins.', `${cleanBrief} confident practical outcome vertical video`],
  ];

  if (durationSec > 24) {
    if (creatorTopic) {
      base[2][2] += ' Track follows, saves, and profile visits.';
      base[3][2] += ' Consistency teaches the right audience to return.';
    } else {
      base[1][2] += ' Compare evidence before choosing what to change.';
      base[2][2] += ' Repetition separates useful signals from random noise.';
      base[3][2] += ' Prioritize the constraint with the biggest effect.';
    }
  }
  if (durationSec > 38) {
    base.splice(base.length - 1, 0, creatorTopic
      ? ['Measurement', 'Measure The Follow-Through', 'Measure what happens after each view: profile visits, saves, follows, and repeat viewers.', 'content creator checking analytics dashboard and follower metrics vertical video']
      : ['Measurement', 'Measure The Change', 'Measure the result after each change so the next decision comes from evidence.', `${cleanBrief} analytics dashboard practical vertical video`]);
    if (!creatorTopic) {
      base.splice(base.length - 1, 0, ['Payoff', 'Close The Loop', 'Keep the change only when repeated evidence shows the outcome actually improved.', `${cleanBrief} reviewing successful outcome vertical video`]);
    }
  }

  while (base.length < req.minScenes) {
    base.splice(base.length - 1, 0, ['Proof', 'Make The Signal Clear', 'Make the next action obvious and measurable.', `${cleanBrief} practical workflow vertical video`]);
  }

  const scenes = base.map((row, index) => ({
    index: index + 1,
    start: 0,
    end: 0,
    purpose: row[0],
    onScreenText: row[1],
    subText: '',
    narration: row[2],
    visualQuery: row[3],
    transition: index === 0 ? 'hard-cut' : 'fast-cut',
    energy: index < 2 ? 'high' : 'medium',
    isBrandCta: creatorTopic && index === base.length - 1,
  }));

  let plan = {
    version: 2,
    title: cleanBrief.slice(0, 90),
    angle: 'A complete creator-first explanation: hook, cause, consequence, fix, payoff and a clear next action.',
    hook: scenes[0].narration,
    voiceover: scenes.map((scene) => scene.narration).join(' '),
    caption: `${cleanBrief}\n\n${creatorTopic ? 'Want a personalized growth system? Book a free strategy session at elevateos.in.' : ''}`.trim(),
    cta: creatorTopic ? 'Book your Free Strategy Session now — Elevate OS — elevateos.in' : 'Use the system, not luck.',
    style: String(options.style || 'cinematic, fast-paced, premium creator reel'),
    durationSec,
    aspectRatio: '9:16',
    width: 1080,
    height: 1920,
    fps: 30,
    musicMood: 'modern, cinematic, energetic but low under narration',
    scenes,
    directorSource: 'deterministic-v2-fallback',
  };
  plan = quality.ensureBrandScene(plan, cleanBrief, options);
  return plan;
}

function normalizePlan(raw, brief, options = {}) {
  const fallback = fallbackPlan(brief, options);
  const durationSec = clamp(raw?.durationSec, 15, 60, fallback.durationSec);
  const req = quality.requirements(durationSec);
  let rawScenes = Array.isArray(raw?.scenes) ? raw.scenes : [];
  if (!rawScenes.length) rawScenes = fallback.scenes;
  const scenes = rawScenes.slice(0, 10).map((scene, index) => ({
    index: index + 1,
    start: 0,
    end: 0,
    purpose: String(scene?.purpose || `Beat ${index + 1}`).slice(0, 100),
    visualQuery: String(scene?.visualQuery || scene?.visual_query || fallback.scenes[index % fallback.scenes.length]?.visualQuery || brief).slice(0, 120),
    onScreenText: String(scene?.onScreenText || scene?.on_screen_text || '').replace(/\s+/g, ' ').trim().slice(0, req.maxOnScreenChars),
    subText: String(scene?.subText || scene?.sub_text || '').replace(/\s+/g, ' ').trim().slice(0, 90),
    narration: String(scene?.narration || '').replace(/\s+/g, ' ').trim().slice(0, 600),
    transition: String(scene?.transition || (index ? 'fast-cut' : 'hard-cut')).slice(0, 40),
    energy: String(scene?.energy || 'medium').slice(0, 30),
    isBrandCta: Boolean(scene?.isBrandCta || scene?.is_brand_cta),
  }));

  let plan = {
    version: 2,
    title: String(raw?.title || fallback.title).slice(0, 120),
    angle: String(raw?.angle || fallback.angle).slice(0, 500),
    hook: String(raw?.hook || scenes[0]?.narration || fallback.hook).slice(0, 300),
    voiceover: String(raw?.voiceover || '').replace(/\s+/g, ' ').trim().slice(0, 5000),
    caption: String(raw?.caption || fallback.caption).slice(0, 2200),
    cta: String(raw?.cta || fallback.cta).slice(0, 300),
    style: String(raw?.style || options.style || fallback.style).slice(0, 120),
    durationSec,
    aspectRatio: '9:16',
    width: 1080,
    height: 1920,
    fps: 30,
    musicMood: String(raw?.musicMood || raw?.music_mood || fallback.musicMood).slice(0, 160),
    scenes,
    directorSource: String(raw?.directorSource || 'cloud-ai-v2'),
  };
  plan = quality.ensureBrandScene(plan, brief, options);
  return plan;
}

function directorPrompt(brief, durationSec, style, options = {}) {
  const req = quality.requirements(durationSec);
  const branded = quality.shouldBrand(brief, options);
  return [
    'You are ULTRON Reel Director v2. Create a FINISHED, information-dense Instagram Reel production plan, never a chain of vague fragments.',
    'Return ONLY one valid JSON object. No markdown.',
    `Topic: ${String(brief || '').trim()}`,
    `Duration: ${durationSec} seconds. Style: ${style}.`,
    `Narration target: ${req.targetWords} words; acceptable range ${req.minWords}-${req.maxWords} words. This is a hard SPOKEN budget, not a writing suggestion.`,
    `The narrator must finish at least ${req.narrationTailRoomSec.toFixed(2)} seconds before the final frame. Do not spend the whole duration talking.`,
    `Use at least ${req.minScenes} scenes. Structure: pattern-interrupt hook → context/diagnosis → real cause/mechanism → consequence → specific actionable fix → measurable payoff/outcome → final CTA.`,
    'Every scene narration must be a complete grammatical sentence with a finished thought. Never output fragments such as "The platform algorithm", "Add diversity", or a sentence cut mid-clause.',
    'Each non-CTA scene should usually communicate ONE useful idea in roughly 7–12 spoken words. Every sentence must add new information.',
    'On-screen text is a headline, not the explanation: use 2–5 short words. Supporting text is optional and must never carry information the narration forgot to finish.',
    'Use concrete human/action B-roll: creators checking analytics, reviewing posts, planning content, filming, editing, or measuring performance. Avoid abstract/glitch visuals unless they are a brief accent.',
    'Do not repeat the same idea in different words. The viewer must understand WHY the problem happens, WHAT it causes, WHAT to do, and WHAT success looks like.',
    branded
      ? 'MANDATORY final scene: Elevate OS brand close. On-screen text must communicate "BOOK YOUR FREE STRATEGY SESSION NOW" and show "elevateos.in". The final narration must explicitly invite the viewer to book the free strategy session with Elevate OS now. Value first, CTA last.'
      : 'Do not add a brand promotion unless the topic explicitly asks for one.',
    'The voiceover field must exactly equal the complete scene narrations in order. Scene timings will be normalized by the renderer; do not overlap scenes.',
    'JSON schema:',
    '{"title":"","angle":"","hook":"","voiceover":"","caption":"","cta":"","style":"","durationSec":20,"musicMood":"","scenes":[{"purpose":"","visualQuery":"","onScreenText":"","subText":"","narration":"","transition":"fast-cut","energy":"high","isBrandCta":false}]}',
  ].join('\n');
}

async function askDirector(prompt) {
  const result = await integrations.chat([
    { role: 'system', content: 'You are a senior short-form video strategist and editor. Produce complete, useful, retention-focused plans, respect real spoken duration, and obey JSON-only output.' },
    { role: 'user', content: prompt },
  ], 'auto', null, { taskType: 'planning' });
  return extractJson(extractText(result));
}

async function directPlan(brief, options = {}) {
  if (options.localOnly) return fallbackPlan(brief, options);
  const durationSec = clamp(options.durationSec, 15, 60, 30);
  const style = String(options.style || 'cinematic, fast-paced, premium creator reel');
  try {
    const first = normalizePlan(await askDirector(directorPrompt(brief, durationSec, style, options)), brief, { ...options, durationSec, style });
    let audit = quality.auditPlan(first, brief, options);
    if (audit.ok) return { ...first, qualityAudit: audit };

    const repairPrompt = [
      directorPrompt(brief, durationSec, style, options),
      'The previous plan failed these quality checks:',
      ...audit.issues.map((issue) => `- ${issue}`),
      'Rewrite the WHOLE JSON plan. Preserve complete sentences and useful explanation, but shorten ideas instead of cutting sentences or rushing the narrator.',
      `Previous plan: ${JSON.stringify(first)}`,
    ].join('\n');
    const repaired = normalizePlan(await askDirector(repairPrompt), brief, { ...options, durationSec, style });
    audit = quality.auditPlan(repaired, brief, options);
    if (audit.ok) return { ...repaired, qualityAudit: audit, repaired: true };

    const fallback = fallbackPlan(brief, { ...options, durationSec, style });
    return { ...fallback, qualityAudit: quality.auditPlan(fallback, brief, options), directorError: `AI plan remained below quality threshold: ${audit.issues.join('; ')}` };
  } catch (error) {
    const fallback = fallbackPlan(brief, { ...options, durationSec, style });
    return { ...fallback, qualityAudit: quality.auditPlan(fallback, brief, options), directorError: error.message };
  }
}

async function sourceScenes(plan, options = {}) {
  const used = new Set();
  const scenes = [];
  for (const scene of plan.scenes) {
    const found = await sources.searchVideos(scene.visualQuery, { perPage: 10, orientation: 'portrait' });
    const candidate = found.items.find((item) => !used.has(`${item.provider}:${item.id}`)) || found.items[0] || null;
    if (candidate) used.add(`${candidate.provider}:${candidate.id}`);
    scenes.push({
      ...scene,
      asset: candidate,
      assetSearch: {
        ok: Boolean(candidate),
        provider: found.provider,
        query: scene.visualQuery,
        errors: found.errors,
      },
    });
  }
  return { ...plan, scenes };
}

function jobPaths(id) {
  const dir = path.join(REEL_ROOT, id);
  return {
    dir,
    job: path.join(dir, 'job.json'),
    plan: path.join(dir, 'plan.json'),
    output: path.join(dir, 'reel.mp4'),
    narration: path.join(dir, 'narration.wav'),
    assets: path.join(dir, 'assets'),
  };
}

async function createJob(brief, options = {}) {
  const cleanBrief = String(brief || '').trim();
  if (!cleanBrief) throw new Error('A reel brief is required.');
  const id = reelId(cleanBrief);
  const paths = jobPaths(id);
  fs.mkdirSync(paths.assets, { recursive: true });
  let plan = await directPlan(cleanBrief, options);
  const audit = quality.auditPlan(plan, cleanBrief, options);
  plan.qualityAudit = audit;
  writeJsonAtomic(paths.plan, plan);

  let state = audit.ok ? 'planned' : 'waiting_quality';
  if (audit.ok && options.fetchAssets !== false && sources.status().anyConfigured) {
    plan = await sourceScenes(plan, options);
    writeJsonAtomic(paths.plan, plan);
    state = plan.scenes.every((scene) => scene.asset) ? 'assets_selected' : 'waiting_assets';
  } else if (audit.ok && options.fetchAssets !== false) {
    state = 'waiting_source_credentials';
  }

  const job = {
    id,
    brief: cleanBrief,
    state,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    zeroCostOnly: true,
    paidGenerationAllowed: false,
    aspectRatio: '9:16',
    planPath: paths.plan,
    outputPath: paths.output,
    rendererImplemented: true,
    qualityAudit: audit,
    sourceStatus: sources.status(),
    narrator: narrator.status(plan.style),
    ffmpeg: ffmpegStatus(),
  };
  writeJsonAtomic(paths.job, job);
  return { job, plan, paths };
}

function status() {
  const sourceStatus = sources.status();
  const ffmpeg = ffmpegStatus();
  const narratorStatus = narrator.status();
  return {
    root: REEL_ROOT,
    version: 2,
    directorImplemented: true,
    contentQualityGateImplemented: true,
    stockSourceRouterImplemented: true,
    stockSourceReady: sourceStatus.anyConfigured,
    sourceStatus,
    ffmpeg,
    rendererImplemented: true,
    safeCaptionLayoutImplemented: true,
    brandCtaImplemented: true,
    narrator: narratorStatus,
    voiceoverBridgeImplemented: true,
    instagramPublishConnected: Boolean(String(process.env.INSTAGRAM_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN || '').trim() && String(process.env.INSTAGRAM_ACCOUNT_ID || '').trim()),
    zeroCostOnly: true,
    paidGenerationAllowed: false,
    nextBlocker: !sourceStatus.anyConfigured
      ? 'Add PEXELS_API_KEY.'
      : !ffmpeg.available
        ? 'FFmpeg is not available on PATH.'
        : !narratorStatus.configured
          ? 'Configure a separate Reel narrator voice profile; Ultron voice fallback is disabled.'
          : null,
  };
}

module.exports = {
  REEL_ROOT,
  reelId,
  ffmpegStatus,
  extractText,
  extractJson,
  fallbackPlan,
  normalizePlan,
  directorPrompt,
  directPlan,
  sourceScenes,
  jobPaths,
  createJob,
  status,
};
