const fs = require('fs');
const path = require('path');
const config = require('./config');

const NARRATOR_FILE = path.resolve(config.projectRoot, '.ultron', 'reels', 'narrators.json');

function readProfiles() {
  try {
    const parsed = JSON.parse(fs.readFileSync(NARRATOR_FILE, 'utf8'));
    return Array.isArray(parsed?.profiles) ? parsed.profiles : [];
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
    speed: Number(process.env.ULTRON_M3_REEL_NARRATOR_SPEED || 1.02),
  };
}

function chooseProfile(style = '') {
  const profiles = [envProfile(), ...readProfiles()].filter(Boolean);
  if (!profiles.length) return null;
  const tags = String(style || '').toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
  return profiles
    .map((profile) => ({
      profile,
      score: (Array.isArray(profile.styleTags) ? profile.styleTags : []).reduce((score, tag) => score + (tags.includes(String(tag).toLowerCase()) ? 2 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score)[0].profile;
}

async function speak(text, options = {}) {
  const profile = chooseProfile(options.style);
  if (!profile) {
    const error = new Error('No Reel narrator voice is configured. Add ULTRON_M3_REEL_NARRATOR_REFERENCE_ID or install narrator profiles. Ultron voice will not be used as a silent fallback.');
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
    volume: 4,
    temperature: 0.68,
    topP: 0.82,
    metallic: false,
  });
  return {
    ...result,
    narratorProfile: profile.name || profile.id || 'Reel Narrator',
    narratorProfileId: profile.id || null,
    metallicApplied: false,
  };
}

function status(style = '') {
  const profile = chooseProfile(style);
  return {
    configured: Boolean(profile),
    profile: profile ? { id: profile.id || null, name: profile.name || null, provider: profile.provider || 'fish', styleTags: profile.styleTags || [] } : null,
    profileFile: NARRATOR_FILE,
    ultronVoiceFallbackAllowed: false,
  };
}

module.exports = { NARRATOR_FILE, readProfiles, envProfile, chooseProfile, speak, status };
