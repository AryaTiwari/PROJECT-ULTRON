const fs = require('fs');
const path = require('path');
const narrator = require('../core/reel-narrator');
const config = require('../core/config');
const fish = require('../../core/voice/fish-tts-free');

function fail(message) {
  console.error(`ULTRON Reel narrator setup failed: ${message}`);
  process.exit(1);
}

function list(value, fallback = '') {
  return String(value || fallback).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

async function main() {
  const explicitSample = String(process.argv[2] || '').trim();
  const sampleArg = explicitSample || config.voiceReferencePath;
  const name = String(process.argv[3] || 'Elevate Creator Narrator').trim();
  const tags = list(process.argv[4], 'calm,educational,premium,informative,clear');
  const useCases = list(process.argv[5], 'educational,strategy');
  const role = String(process.argv[6] || 'explainer').trim().toLowerCase();
  const priority = Math.max(-10, Math.min(10, Number(process.argv[7] || 0)));
  const speed = Math.max(0.78, Math.min(1.28, Number(process.argv[8] || 1.02)));

  const sample = path.resolve(sampleArg);
  if (!fs.existsSync(sample) || !fs.statSync(sample).isFile()) {
    const hint = explicitSample
      ? `Voice sample not found: ${sample}`
      : `The configured ULTRON voice reference was not found at ${sample}. Pass a local narrator MP3/WAV path as the first argument.`;
    fail(hint);
  }
  if (!/\.(?:mp3|wav|m4a|ogg|flac)$/i.test(sample)) fail('Narrator sample must be MP3, WAV, M4A, OGG or FLAC.');

  const cloned = await fish.cloneVoice({ referencePath: sample, title: `ULTRON Reel Narrator — ${name}`, persistState: false });
  if (!cloned?.voiceId) fail('Fish Audio returned no narrator voice reference ID.');

  const file = narrator.NARRATOR_FILE;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let current = { version: 2, profiles: [] };
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!Array.isArray(current.profiles)) current.profiles = [];
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `narrator-${Date.now()}`;
  const profile = {
    id,
    name,
    provider: 'fish',
    referenceId: cloned.voiceId,
    styleTags: tags,
    useCases,
    role,
    priority,
    speed,
    enabled: true,
    createdAt: new Date().toISOString(),
    sourceSample: explicitSample ? 'explicit-local-file' : 'configured-ultron-reference',
  };
  current.version = 2;
  current.profiles = [profile, ...current.profiles.filter((item) => item.id !== id)];
  fs.writeFileSync(file, JSON.stringify(current, null, 2), 'utf8');

  console.log(`ULTRON Reel narrator ready: ${name}.`);
  console.log(`Role: ${role}. Use cases: ${useCases.join(', ')}.`);
  console.log(`Style tags: ${tags.join(', ')}. Priority: ${priority}. Speed: ${speed}.`);
  console.log(`Sample source: ${explicitSample ? 'explicit local file' : 'configured ULTRON voice reference'}; Reel profile created separately.`);
  console.log('Ultron assistant voice was not changed. Metallic ULTRON post-processing remains disabled for Reel narration.');
  console.log('No API key or narrator reference ID was printed.');
}

main().catch((error) => fail(error.message));
