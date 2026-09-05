const fs = require('fs');
const path = require('path');
const narrator = require('../core/reel-narrator');
const fish = require('../../core/voice/fish-tts-free');

function fail(message) {
  console.error(`ULTRON Reel narrator setup failed: ${message}`);
  process.exit(1);
}

function list(value, fallback = '') {
  return String(value || fallback).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

async function main() {
  const sampleArg = String(process.argv[2] || '').trim();
  const name = String(process.argv[3] || 'Calm Creator Narrator').trim();
  const tags = list(process.argv[4], 'calm,educational,premium,informative,clear');
  const useCases = list(process.argv[5], 'educational,strategy');
  const role = String(process.argv[6] || 'explainer').trim().toLowerCase();
  const priority = Math.max(-10, Math.min(10, Number(process.argv[7] || 0)));
  const speed = Math.max(0.78, Math.min(1.28, Number(process.argv[8] || 1.02)));

  if (!sampleArg) fail('Pass a local narrator sample file path as the first argument.');
  const sample = path.resolve(sampleArg);
  if (!fs.existsSync(sample) || !fs.statSync(sample).isFile()) fail(`Voice sample not found: ${sample}`);
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
  };
  current.version = 2;
  current.profiles = [profile, ...current.profiles.filter((item) => item.id !== id)];
  fs.writeFileSync(file, JSON.stringify(current, null, 2), 'utf8');

  console.log(`ULTRON Reel narrator ready: ${name}.`);
  console.log(`Role: ${role}. Use cases: ${useCases.join(', ')}.`);
  console.log(`Style tags: ${tags.join(', ')}. Priority: ${priority}. Speed: ${speed}.`);
  console.log('Ultron assistant voice was not changed.');
  console.log('No API key or narrator reference ID was printed.');
}

main().catch((error) => fail(error.message));
