const fs = require('fs');
const path = require('path');
const config = require('../core/config');
const narrator = require('../core/reel-narrator');
const fish = require('../../core/voice/fish-tts-free');

function fail(message) {
  console.error(`ULTRON Reel narrator setup failed: ${message}`);
  process.exit(1);
}

async function main() {
  const sampleArg = String(process.argv[2] || '').trim();
  const name = String(process.argv[3] || 'Calm Creator Narrator').trim();
  const tags = String(process.argv[4] || 'calm,educational,premium,cinematic')
    .split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  if (!sampleArg) fail('Pass a local narrator sample file path as the first argument.');
  const sample = path.resolve(sampleArg);
  if (!fs.existsSync(sample) || !fs.statSync(sample).isFile()) fail(`Voice sample not found: ${sample}`);
  if (!/\.(?:mp3|wav|m4a|ogg|flac)$/i.test(sample)) fail('Narrator sample must be MP3, WAV, M4A, OGG or FLAC.');

  const cloned = await fish.cloneVoice({ referencePath: sample, title: `ULTRON Reel Narrator — ${name}`, persistState: false });
  if (!cloned?.voiceId) fail('Fish Audio returned no narrator voice reference ID.');

  const file = narrator.NARRATOR_FILE;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let current = { version: 1, profiles: [] };
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!Array.isArray(current.profiles)) current.profiles = [];
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `narrator-${Date.now()}`;
  const profile = { id, name, provider: 'fish', referenceId: cloned.voiceId, styleTags: tags, speed: 1.02, createdAt: new Date().toISOString() };
  current.version = 1;
  current.profiles = [profile, ...current.profiles.filter((item) => item.id !== id)];
  fs.writeFileSync(file, JSON.stringify(current, null, 2), 'utf8');

  console.log(`ULTRON Reel narrator ready: ${name}.`);
  console.log(`Style tags: ${tags.join(', ')}.`);
  console.log('Ultron assistant voice was not changed.');
  console.log('No API key or narrator reference ID was printed.');
}

main().catch((error) => fail(error.message));
