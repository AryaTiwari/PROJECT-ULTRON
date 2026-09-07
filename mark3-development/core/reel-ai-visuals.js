const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const DEFAULT_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const USAGE_FILE = path.resolve(config.projectRoot, '.ultron', 'reel-ai-visual-usage.json');
const DEFAULT_DAILY_MAX = 4;

function env(name, fallback = '') {
  const value = String(process.env[name] ?? fallback).trim();
  return value;
}

function enabled() {
  return env('ULTRON_M3_CF_AI_IMAGE_ENABLED', '0') === '1';
}

function credentials() {
  return {
    accountId: env('CLOUDFLARE_ACCOUNT_ID') || env('CF_ACCOUNT_ID'),
    token: env('CLOUDFLARE_API_TOKEN') || env('CLOUDFLARE_WORKERS_AI_TOKEN'),
  };
}

function model() {
  return env('ULTRON_M3_CF_AI_IMAGE_MODEL', DEFAULT_MODEL) || DEFAULT_MODEL;
}

function dailyMax() {
  return Math.max(1, Math.min(24, Number(env('ULTRON_M3_CF_AI_DAILY_MAX', DEFAULT_DAILY_MAX)) || DEFAULT_DAILY_MAX));
}

function steps() {
  return Math.max(1, Math.min(8, Number(env('ULTRON_M3_CF_AI_STEPS', '4')) || 4));
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function readUsage() {
  try {
    const value = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    if (value?.day === utcDay()) return { day: value.day, count: Math.max(0, Number(value.count || 0)) };
  } catch {}
  return { day: utcDay(), count: 0 };
}

function writeUsage(value) {
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    const temp = `${USAGE_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value), 'utf8');
    fs.renameSync(temp, USAGE_FILE);
  } catch {}
}

function remainingToday() {
  return Math.max(0, dailyMax() - readUsage().count);
}

function status() {
  const creds = credentials();
  const active = enabled();
  const remaining = remainingToday();
  return {
    implemented: true,
    enabled: active,
    configured: Boolean(creds.accountId && creds.token),
    ready: Boolean(active && creds.accountId && creds.token && remaining > 0),
    provider: 'cloudflare-workers-ai',
    model: model(),
    modelLicense: model() === DEFAULT_MODEL ? 'Apache-2.0' : 'provider-model-terms',
    commercialUse: model() === DEFAULT_MODEL,
    mode: 'text-to-image-local-motion-fallback',
    dailyMax: dailyMax(),
    usedToday: readUsage().count,
    remainingToday: remaining,
    billingPolicy: 'local-daily-cap; no third-party paid fallback',
    missing: [
      ...(!creds.accountId ? ['CLOUDFLARE_ACCOUNT_ID'] : []),
      ...(!creds.token ? ['CLOUDFLARE_API_TOKEN'] : []),
      ...(!active ? ['ULTRON_M3_CF_AI_IMAGE_ENABLED=1'] : []),
    ],
  };
}

function promptForScene(scene = {}, plan = {}) {
  const subject = String(scene.visualQuery || scene.purpose || plan.title || '').replace(/\s+/g, ' ').trim();
  const context = String(scene.narration || '').replace(/\s+/g, ' ').trim();
  return [
    'Premium cinematic editorial photograph for a vertical 9:16 social-media Reel.',
    subject || 'modern creator workflow in a premium workspace',
    context ? `Visual meaning: ${context}` : '',
    'Realistic human/action scene, strong composition, natural lighting, modern color grading, useful visual storytelling.',
    'Keep the main subject near the center with generous room above and below so a square source can be cropped vertically.',
    'No visible words, captions, logos, watermarks, brand marks, celebrity likenesses, copyrighted characters, UI text, or distorted hands.',
  ].filter(Boolean).join(' ');
}

function endpoint() {
  const creds = credentials();
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(creds.accountId)}/ai/run/${model()}`;
}

function seedFor(prompt) {
  const digest = crypto.createHash('sha256').update(String(prompt || '')).digest();
  return digest.readUInt32BE(0) % 2147483647;
}

async function generateImage(prompt, destination, options = {}) {
  const current = status();
  if (!current.enabled) throw new Error('Cloudflare AI image fallback is disabled. Set ULTRON_M3_CF_AI_IMAGE_ENABLED=1 to enroll it.');
  if (!current.configured) throw new Error(`Cloudflare AI image fallback is missing: ${current.missing.join(', ')}.`);
  if (current.remainingToday <= 0) throw new Error(`Cloudflare AI image daily cap reached (${current.dailyMax}).`);

  const usePrompt = String(prompt || '').trim().slice(0, 2048);
  if (!usePrompt) throw new Error('Cloudflare AI image prompt is empty.');
  const useSteps = Math.max(1, Math.min(8, Number(options.steps || steps()) || steps()));
  const seed = Number.isFinite(Number(options.seed)) ? Number(options.seed) : seedFor(usePrompt);
  const controller = new AbortController();
  const timeoutMs = Math.max(15000, Number(options.timeoutMs || process.env.ULTRON_M3_CF_AI_TIMEOUT_MS || 90000));
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials().token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ prompt: usePrompt, steps: useSteps, seed }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
    if (!response.ok || data?.success === false) {
      const detail = data?.errors?.[0]?.message || data?.error?.message || data?.message || raw.slice(0, 500) || `HTTP ${response.status}`;
      const error = new Error(`Cloudflare Workers AI HTTP ${response.status}: ${detail}`);
      error.status = response.status;
      throw error;
    }

    const image = String(data?.result?.image || data?.image || '').trim();
    if (!image) throw new Error('Cloudflare Workers AI returned no generated image.');
    const bytes = Buffer.from(image, 'base64');
    if (bytes.length < 4096) throw new Error(`Cloudflare Workers AI returned an unexpectedly small image (${bytes.length} bytes).`);
    const target = path.resolve(destination);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);

    const usage = readUsage();
    usage.count += 1;
    writeUsage(usage);
    return {
      ok: true,
      path: target,
      bytes: bytes.length,
      provider: 'cloudflare-workers-ai',
      mediaType: 'generated-image',
      generated: true,
      model: model(),
      prompt: usePrompt,
      seed,
      steps: useSteps,
      license: model() === DEFAULT_MODEL ? 'Apache-2.0 (FLUX.1 schnell)' : 'provider-model-terms',
      commercialUse: model() === DEFAULT_MODEL,
      attribution: `AI-generated with ${model()} on Cloudflare Workers AI`,
      sourcePage: 'https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/',
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Cloudflare Workers AI image generation timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_MODEL,
  USAGE_FILE,
  enabled,
  credentials,
  model,
  dailyMax,
  steps,
  readUsage,
  remainingToday,
  status,
  promptForScene,
  seedFor,
  generateImage,
};
