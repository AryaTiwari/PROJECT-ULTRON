const fs = require('fs');
const path = require('path');
const config = require('./config');

const NARRATOR_FILE = path.resolve(config.projectRoot, '.ultron', 'reels', 'narrators.json');

function readProfiles() {
  try {
    const parsed = JSON.parse(fs.readFileSync(NARRATOR_FILE, 'utf8'));
    return Array.isArray(parsed?.profiles) ? parsed.profiles.filter((profile) => profile?.enabled !== false) : [];
  } catch {
    return [];
  }
}

function envProfile() {
  const referenceId = String(process.env.ULTRON_M3_REEL_NARRATOR_REFERENCE_ID || '').trim();
  if (!referenceId) return null;
  return {
    id: 'env-default',
    name: String(process.env.ULTRON_M3_REEL_NARRATOR_NAME || 'Default Reel Narrator').trim(),
    provider: String(process.env.ULTRON_M3_REEL_NARRATOR_PROVIDER || 'fish').trim().toLowerCase(),
    referenceId,
    styleTags: String(process.env.ULTRON_M3_REEL_NARRATOR_TAGS || 'calm,educational,premium').split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean),
    useCases: ['default'],
    speed: Number(process.env.ULTRON_M3_REEL_NARRATOR_SPEED || 1.02),
    priority: 0,
  };
}

function words(value) {
  return String(value || '').toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
}

function inferIntent(context = {}) {
  const source = typeof context === 'string'
    ? context
    : [context.style, context.brief, context.title, context.angle, context.purpose].filter(Boolean).join(' ');
  const text = String(source || '').toLowerCase();
  const tags = new Set(words(text));
  const add = (...values) => values.forEach((value) => tags.add(value));

  if (/\b(?:why|how|explain|explainer|educational|learn|guide|strategy|growth|metrics?|analytics|psychology|mistakes?|tips?|framework|system|creator|content|followers?|views?|retention|conversion)\b/i.test(text)) {
    add('educational', 'informative', 'clear', 'strategy');
  }
  if (/\b(?:business|brand|founder|premium|luxury|professional|case study|consulting|strategy session|elevate os)\b/i.test(text)) {
    add('premium', 'credible', 'calm');
  }
  if (/\b(?:story|storytelling|pov|advice|relatable|friend|personal|confession|day in the life|casual)\b/i.test(text)) {
    add('conversational', 'relatable', 'warm');
  }
  if (/\b(?:funny|comedy|witty|sarcastic|roast|myth|hot take|unpopular opinion|plot twist|chaotic)\b/i.test(text)) {
    add('witty', 'playful', 'sarcastic');
  }
  if (/\b(?:challenge|trend|viral|energetic|hype|fast-paced|fast paced|shocking|crazy|watch this|gaming|game)\b/i.test(text)) {
    add('energetic', 'high-energy', 'entertaining');
  }
  if (/\b(?:dark|cinematic|emotional|dramatic|storytelling|motivational|inspiring)\b/i.test(text)) {
    add('cinematic', 'dramatic');
  }
  if (/\b(?:free strategy session|book|cta|call to action|elevateos\.in)\b/i.test(text)) {
    add('credible', 'warm', 'clear');
  }
  return [...tags];
}

function normalizeProfile(profile) {
  return {
    ...profile,
    styleTags: Array.isArray(profile?.styleTags) ? profile.styleTags.map((tag) => String(tag).toLowerCase()) : [],
    useCases: Array.isArray(profile?.useCases) ? profile.useCases.map((tag) => String(tag).toLowerCase()) : [],
    priority: Number(profile?.priority || 0),
  };
}

function chooseProfile(context = {}) {
  const profiles = [envProfile(), ...readProfiles()].filter(Boolean).map(normalizeProfile);
  if (!profiles.length) return null;
  const requested = inferIntent(context);
  const requestedSet = new Set(requested);

  return profiles
    .map((profile, index) => {
      let score = profile.priority;
      for (const tag of profile.styleTags) {
        if (requestedSet.has(tag)) score += 3;
        if (tag === 'default') score += 0.25;
      }
      for (const useCase of profile.useCases) {
        if (requestedSet.has(useCase)) score += 5;
        if (useCase === 'default') score += 0.5;
      }
      if (profile.role && requestedSet.has(String(profile.role).toLowerCase())) score += 6;
      return { profile, score, index };
    })
    .sort((a, b) => b.score - a.score || b.profile.priority - a.profile.priority || a.index - b.index)[0].profile;
}

async function speak(text, options = {}) {
  const context = {
    style: options.style,
    brief: options.brief,
    title: options.title,
    angle: options.angle,
    purpose: options.purpose,
  };
  const profile = chooseProfile(context);
  if (!profile) {
    const error = new Error('No Reel narrator voice is configured. Install at least one permitted narrator profile. Ultron voice will not be used as a silent fallback.');
    error.code = 'REEL_NARRATOR_MISSING';
    throw error;
  }
  const provider = String(profile.provider || 'fish').toLowerCase();
  if (provider !== 'fish' && provider !== 'fish-audio-s2.1-pro-free') {
    throw new Error(`Unsupported Reel narrator provider: ${provider}. Current v2 narrator profiles use Fish voice references.`);
  }
  const fish = require('../../core/voice/fish-tts-free');
  const result = await fish.synthesize(text, {
    referenceId: profile.referenceId,
    outputDir: options.outputDir,
    filename: options.filename,
    speed: Number.isFinite(Number(profile.speed)) ? Number(profile.speed) : 1.02,
    volume: Number.isFinite(Number(profile.volume)) ? Number(profile.volume) : 4,
    temperature: Number.isFinite(Number(profile.temperature)) ? Number(profile.temperature) : 0.68,
    topP: Number.isFinite(Number(profile.topP)) ? Number(profile.topP) : 0.82,
    metallic: false,
  });
  return {
    ...result,
    narratorProfile: profile.name || profile.id || 'Reel Narrator',
    narratorProfileId: profile.id || null,
    narratorIntent: inferIntent(context),
    metallicApplied: false,
  };
}

function status(context = {}) {
  const profile = chooseProfile(context);
  return {
    configured: Boolean(profile),
    profile: profile ? {
      id: profile.id || null,
      name: profile.name || null,
      provider: profile.provider || 'fish',
      styleTags: profile.styleTags || [],
      useCases: profile.useCases || [],
      role: profile.role || null,
    } : null,
    inferredIntent: inferIntent(context),
    profileCount: [envProfile(), ...readProfiles()].filter(Boolean).length,
    profileFile: NARRATOR_FILE,
    ultronVoiceFallbackAllowed: false,
  };
}

module.exports = { NARRATOR_FILE, readProfiles, envProfile, inferIntent, chooseProfile, speak, status };
