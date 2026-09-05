const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('./config');
const instagram = require('./instagram');
const { writeJsonAtomic, readJson } = require('./persistence');

const ROOT = path.resolve(config.projectRoot, '.ultron', 'adaptive', 'instagram');
const SNAPSHOT_PATH = path.join(ROOT, 'aesthetic.json');
const MAX_ASSETS = 6;

function ensureRoot() { fs.mkdirSync(ROOT, { recursive: true }); }
function hex(v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'); }
function rgbHex(rgb) { return `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`.toUpperCase(); }
function luminance(rgb) { return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255; }
function saturation(rgb) {
  const max = Math.max(rgb.r, rgb.g, rgb.b) / 255;
  const min = Math.min(rgb.r, rgb.g, rgb.b) / 255;
  if (max === min) return 0;
  const l = (max + min) / 2;
  return (max - min) / (1 - Math.abs(2 * l - 1));
}
function warmth(rgb) { return (rgb.r - rgb.b) / 255; }

async function download(url, file) {
  if (!url) return null;
  ensureRoot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'ULTRON-Mark3/1.0' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('empty media');
    fs.writeFileSync(file, buffer);
    return file;
  } finally { clearTimeout(timer); }
}

function samplePixels(file, size = 5) {
  if (!file || !fs.existsSync(file)) return [];
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', `scale=${size}:${size}:force_original_aspect_ratio=decrease,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { timeout: 30000, windowsHide: true, encoding: null, maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) return [];
  const pixels = [];
  for (let i = 0; i + 2 < result.stdout.length; i += 3) pixels.push({ r: result.stdout[i], g: result.stdout[i + 1], b: result.stdout[i + 2] });
  return pixels;
}

function paletteFromPixels(pixels = [], limit = 5) {
  const buckets = new Map();
  for (const p of pixels) {
    const q = { r: Math.round(p.r / 48) * 48, g: Math.round(p.g / 48) * 48, b: Math.round(p.b / 48) * 48 };
    const key = `${q.r},${q.g},${q.b}`;
    const row = buckets.get(key) || { ...q, count: 0 };
    row.count += 1;
    buckets.set(key, row);
  }
  return [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, limit).map((row) => ({ hex: rgbHex(row), weight: row.count }));
}

function averageColor(pixels = []) {
  if (!pixels.length) return null;
  const sum = pixels.reduce((acc, p) => ({ r: acc.r + p.r, g: acc.g + p.g, b: acc.b + p.b }), { r: 0, g: 0, b: 0 });
  return { r: sum.r / pixels.length, g: sum.g / pixels.length, b: sum.b / pixels.length };
}

function classifyVisual(rgb, sat) {
  if (!rgb) return [];
  const lum = luminance(rgb);
  const warm = warmth(rgb);
  const tags = [];
  tags.push(lum < 0.34 ? 'dark' : lum > 0.72 ? 'bright' : 'mid-tone');
  tags.push(sat < 0.18 ? 'muted' : sat > 0.55 ? 'vivid' : 'balanced-color');
  tags.push(warm > 0.08 ? 'warm' : warm < -0.08 ? 'cool' : 'neutral');
  if (lum < 0.45 && sat < 0.35) tags.push('minimal-cinematic');
  if (lum > 0.62 && sat < 0.25) tags.push('clean-airy');
  return tags;
}

function captionSignals(media = []) {
  const captions = media.map((item) => String(item.caption || '').trim()).filter(Boolean);
  if (!captions.length) return { available: false, averageChars: 0, emojiDensity: 0, questionRate: 0, ctaRate: 0 };
  const totalChars = captions.reduce((sum, value) => sum + value.length, 0);
  const emojiMatches = captions.join(' ').match(/[\p{Extended_Pictographic}]/gu) || [];
  const questionCount = captions.filter((value) => /\?/.test(value)).length;
  const ctaCount = captions.filter((value) => /\b(?:dm|comment|link|book|follow|save|share|check out|visit|bio)\b/i.test(value)).length;
  return {
    available: true,
    averageChars: Math.round(totalChars / captions.length),
    emojiDensity: Number((emojiMatches.length / Math.max(1, captions.length)).toFixed(2)),
    questionRate: Number((questionCount / captions.length).toFixed(2)),
    ctaRate: Number((ctaCount / captions.length).toFixed(2)),
    samples: captions.slice(0, 4).map((value) => value.slice(0, 180)),
  };
}

async function analyze(options = {}) {
  ensureRoot();
  const snapshot = await instagram.accountSnapshot({ limit: options.limit || 10 });
  const assets = [];
  if (snapshot.profile?.profilePictureUrl) assets.push({ type: 'profile-picture', url: snapshot.profile.profilePictureUrl });
  for (const item of snapshot.media || []) {
    const url = item.thumbnailUrl || (item.mediaType === 'IMAGE' ? item.mediaUrl : null);
    if (url) assets.push({ type: item.mediaType || 'media', url, id: item.id });
    if (assets.length >= MAX_ASSETS) break;
  }

  const allPixels = [];
  const sampled = [];
  for (let i = 0; i < assets.length; i += 1) {
    const asset = assets[i];
    const file = path.join(ROOT, `sample-${String(i + 1).padStart(2, '0')}.img`);
    try {
      await download(asset.url, file);
      const pixels = samplePixels(file, 5);
      allPixels.push(...pixels);
      sampled.push({ type: asset.type, id: asset.id || null, pixels: pixels.length });
    } catch (error) {
      sampled.push({ type: asset.type, id: asset.id || null, error: error.message });
    }
  }

  const avg = averageColor(allPixels);
  const sat = avg ? saturation(avg) : null;
  const result = {
    version: 1,
    capturedAt: new Date().toISOString(),
    username: snapshot.profile?.username || null,
    profile: {
      name: snapshot.profile?.name || null,
      biography: snapshot.profile?.biography || null,
      followersCount: snapshot.profile?.followersCount ?? null,
      mediaCount: snapshot.profile?.mediaCount ?? null,
      accountType: snapshot.profile?.accountType || null,
    },
    visual: {
      available: Boolean(allPixels.length),
      averageColor: avg ? rgbHex(avg) : null,
      palette: paletteFromPixels(allPixels),
      luminance: avg ? Number(luminance(avg).toFixed(3)) : null,
      saturation: sat === null ? null : Number(sat.toFixed(3)),
      warmth: avg ? Number(warmth(avg).toFixed(3)) : null,
      tags: classifyVisual(avg, sat || 0),
      sampled,
    },
    captions: captionSignals(snapshot.media || []),
    mediaCountSampled: (snapshot.media || []).length,
    source: 'official-instagram-api-own-account',
  };
  writeJsonAtomic(SNAPSHOT_PATH, result);
  return result;
}

function latest() { return readJson(SNAPSHOT_PATH, null); }
function stale(maxAgeMs = 24 * 60 * 60 * 1000) {
  const value = latest();
  return !value?.capturedAt || Date.now() - Date.parse(value.capturedAt) > maxAgeMs;
}
function summary(value = latest()) {
  if (!value) return 'No Instagram aesthetic snapshot yet.';
  const tags = value.visual?.tags?.join(', ') || 'unknown visual palette';
  const palette = (value.visual?.palette || []).slice(0, 4).map((item) => item.hex).join(', ');
  const caption = value.captions?.available ? `captions avg ${value.captions.averageChars} chars, CTA rate ${value.captions.ctaRate}` : 'caption pattern unavailable';
  return `Instagram aesthetic: ${tags}${palette ? `; palette ${palette}` : ''}; ${caption}.`;
}
function status() {
  const value = latest();
  return { implemented: true, snapshotAvailable: Boolean(value), stale: stale(), path: SNAPSHOT_PATH, source: 'official-own-account-metadata-and-media' };
}

module.exports = { ROOT, SNAPSHOT_PATH, samplePixels, paletteFromPixels, averageColor, classifyVisual, captionSignals, analyze, latest, stale, summary, status };
