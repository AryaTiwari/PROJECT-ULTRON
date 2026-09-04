const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('./config');
const integrations = require('./integrations');
const sources = require('./reel-sources');
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
  const sceneCount = Math.max(4, Math.min(8, Math.round(durationSec / 5)));
  const step = durationSec / sceneCount;
  const cleanBrief = String(brief || '').trim() || 'a useful creator-growth insight';
  const scenes = Array.from({ length: sceneCount }, (_, index) => {
    const start = Number((index * step).toFixed(2));
    const end = Number(((index + 1) * step).toFixed(2));
    const labels = ['Pattern interrupt', 'Problem', 'Why it happens', 'Proof/visual', 'Fix', 'Payoff', 'CTA', 'Brand close'];
    return {
      index: index + 1,
      start,
      end,
      purpose: labels[index] || `Beat ${index + 1}`,
      visualQuery: index === 0 ? `${cleanBrief} dramatic vertical` : `${cleanBrief} creator b-roll vertical`,
      onScreenText: index === 0 ? cleanBrief.slice(0, 70) : '',
      narration: '',
      transition: index === 0 ? 'hard-cut' : 'fast-cut',
      energy: index < 2 ? 'high' : 'medium',
    };
  });
  return {
    version: 1,
    title: cleanBrief.slice(0, 90),
    angle: 'Clear creator-first explanation with a strong hook and practical payoff.',
    hook: cleanBrief,
    voiceover: cleanBrief,
    caption: cleanBrief,
    cta: 'Follow for the next breakdown.',
    style: String(options.style || 'cinematic-fast'),
    durationSec,
    aspectRatio: '9:16',
    width: 1080,
    height: 1920,
    fps: 30,
    musicMood: 'modern, energetic, low under voice',
    scenes,
    directorSource: 'deterministic-fallback',
  };
}

function normalizePlan(raw, brief, options = {}) {
  const fallback = fallbackPlan(brief, options);
  const durationSec = clamp(raw?.durationSec, 15, 60, fallback.durationSec);
  const rawScenes = Array.isArray(raw?.scenes) ? raw.scenes : [];
  const scenes = (rawScenes.length ? rawScenes : fallback.scenes).slice(0, 10).map((scene, index, all) => {
    const defaultStart = index === 0 ? 0 : Number(all[index - 1]?.end ?? fallback.scenes[Math.min(index, fallback.scenes.length - 1)]?.start ?? 0);
    const start = clamp(scene?.start, 0, durationSec, defaultStart);
    const defaultEnd = index === all.length - 1 ? durationSec : Math.min(durationSec, start + Math.max(2.5, durationSec / Math.max(1, all.length)));
    const end = clamp(scene?.end, start + 0.25, durationSec, defaultEnd);
    return {
      index: index + 1,
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      purpose: String(scene?.purpose || `Beat ${index + 1}`).slice(0, 100),
      visualQuery: String(scene?.visualQuery || scene?.visual_query || fallback.scenes[index]?.visualQuery || brief).slice(0, 100),
      onScreenText: String(scene?.onScreenText || scene?.on_screen_text || '').slice(0, 140),
      narration: String(scene?.narration || '').slice(0, 500),
      transition: String(scene?.transition || (index ? 'fast-cut' : 'hard-cut')).slice(0, 40),
      energy: String(scene?.energy || 'medium').slice(0, 30),
    };
  });
  if (scenes.length) {
    scenes[0].start = 0;
    scenes[scenes.length - 1].end = durationSec;
  }
  return {
    version: 1,
    title: String(raw?.title || fallback.title).slice(0, 120),
    angle: String(raw?.angle || fallback.angle).slice(0, 500),
    hook: String(raw?.hook || fallback.hook).slice(0, 300),
    voiceover: String(raw?.voiceover || fallback.voiceover).slice(0, 4000),
    caption: String(raw?.caption || fallback.caption).slice(0, 2200),
    cta: String(raw?.cta || fallback.cta).slice(0, 300),
    style: String(raw?.style || options.style || fallback.style).slice(0, 80),
    durationSec,
    aspectRatio: '9:16',
    width: 1080,
    height: 1920,
    fps: 30,
    musicMood: String(raw?.musicMood || raw?.music_mood || fallback.musicMood).slice(0, 160),
    scenes,
    directorSource: String(raw?.directorSource || 'cloud-ai'),
  };
}

async function directPlan(brief, options = {}) {
  if (options.localOnly) return fallbackPlan(brief, options);
  const durationSec = clamp(options.durationSec, 15, 60, 30);
  const style = String(options.style || 'cinematic, fast-paced, premium creator reel');
  const prompt = [
    'You are ULTRON Reel Director. Design a polished vertical social reel for Instagram.',
    'Return ONLY one valid JSON object. No markdown.',
    `Brief: ${String(brief || '').trim()}`,
    `Target duration: ${durationSec} seconds. Style: ${style}.`,
    'Optimize the first 2 seconds for retention. Keep cuts visually varied and feasible with stock footage plus motion graphics.',
    'Use concrete stock-search phrases in visualQuery. Avoid copyrighted characters, logos, celebrity likenesses, or unverifiable claims.',
    'JSON schema:',
    '{"title":"","angle":"","hook":"","voiceover":"","caption":"","cta":"","style":"","durationSec":30,"musicMood":"","scenes":[{"start":0,"end":4,"purpose":"","visualQuery":"","onScreenText":"","narration":"","transition":"hard-cut","energy":"high"}]}',
  ].join('\n');
  try {
    const result = await integrations.chat([
      { role: 'system', content: 'You create concise, high-retention social-video production plans and obey JSON-only output requirements.' },
      { role: 'user', content: prompt },
    ], 'auto', null, { taskType: 'general' });
    const parsed = extractJson(extractText(result));
    return normalizePlan(parsed, brief, { ...options, durationSec });
  } catch (error) {
    return { ...fallbackPlan(brief, { ...options, durationSec }), directorError: error.message };
  }
}

async function sourceScenes(plan, options = {}) {
  const used = new Set();
  const scenes = [];
  for (const scene of plan.scenes) {
    const found = await sources.searchVideos(scene.visualQuery, { perPage: 8, orientation: 'portrait' });
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
  writeJsonAtomic(paths.plan, plan);

  let state = 'planned';
  if (options.fetchAssets !== false && sources.status().anyConfigured) {
    plan = await sourceScenes(plan, options);
    writeJsonAtomic(paths.plan, plan);
    state = plan.scenes.some((scene) => scene.asset) ? 'assets_selected' : 'waiting_assets';
  } else if (options.fetchAssets !== false) {
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
    rendererImplemented: false,
    sourceStatus: sources.status(),
    ffmpeg: ffmpegStatus(),
  };
  writeJsonAtomic(paths.job, job);
  return { job, plan, paths };
}

function status() {
  const sourceStatus = sources.status();
  const ffmpeg = ffmpegStatus();
  return {
    root: REEL_ROOT,
    directorImplemented: true,
    stockSourceRouterImplemented: true,
    stockSourceReady: sourceStatus.anyConfigured,
    sourceStatus,
    ffmpeg,
    rendererImplemented: false,
    voiceoverBridgeImplemented: false,
    instagramPublishConnected: Boolean(String(process.env.INSTAGRAM_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN || '').trim() && String(process.env.INSTAGRAM_ACCOUNT_ID || '').trim()),
    zeroCostOnly: true,
    paidGenerationAllowed: false,
    nextBlocker: !sourceStatus.anyConfigured
      ? 'Add PEXELS_API_KEY or PIXABAY_API_KEY.'
      : !ffmpeg.available
        ? 'FFmpeg is not available on PATH.'
        : 'Finished Reel renderer is the next implementation step.',
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
  directPlan,
  sourceScenes,
  jobPaths,
  createJob,
  status,
};
