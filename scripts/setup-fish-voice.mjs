import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const voiceDir = path.resolve(process.env.ULTRON_VOICE_ROOT || '.ultron/voice');
const reference = path.join(voiceDir, 'ultron-reference.mp3');
const statePath = path.resolve(process.env.ULTRON_VOICE_CLONE_STATE || path.join(voiceDir, 'voice-clone.json'));
const referenceUrl = process.env.ULTRON_VOICE_REFERENCE_URL || 'https://raw.githubusercontent.com/AryaTiwari/Interface1/main/Ultron-2026-08-27-11-05-%5Bsoft%5D-I-was-designed-to-[emphasis]-save-the-wor.mp3';

function getKeyFromEnv() {
  return String(process.env.FISH_API_KEY || '').trim();
}

async function getStoredKey() {
  try {
    const mod = await import('../core/credentials/local-store.js');
    const stored = await mod.load();
    return String(stored?.FISH_API_KEY || '').trim();
  } catch {
    return '';
  }
}

async function main() {
  fs.mkdirSync(voiceDir, { recursive: true });

  if (!fs.existsSync(reference)) {
    const response = await fetch(referenceUrl, { headers: { 'User-Agent': 'PROJECT-ULTRON/Mark2' } });
    if (!response.ok) throw new Error(`Unable to fetch ULTRON voice reference: HTTP ${response.status}`);
    fs.writeFileSync(reference, Buffer.from(await response.arrayBuffer()));
  }

  const key = getKeyFromEnv() || await getStoredKey();
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
  state.referencePath = reference;
  state.referenceSource = 'AryaTiwari/Interface1';
  state.setupAt = new Date().toISOString();

  if (!key) {
    state.provider = 'nvidia-magpie-zeroshot';
    state.voiceProfileReady = false;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    console.log('ULTRON voice reference is ready. No FISH_API_KEY found; NVIDIA remains the active fallback.');
    console.log('Add a Fish Audio developer key to enable the cloned S2.1 Pro Free voice.');
    return;
  }

  const sdk = await import('fish-audio');
  const fish = new sdk.FishAudioClient({ apiKey: key });
  let voiceId = String(state.fishVoiceId || '').trim();

  if (!voiceId) {
    const response = await fish.voices.ivc.create({
      title: 'ULTRON Voice',
      voices: [fs.createReadStream(reference)],
    });
    voiceId = String(response._id || '').trim();
    if (!voiceId) throw new Error('Fish Audio did not return a voice ID.');
    state.fishVoiceState = response.state;
  }

  state.provider = 'fish-audio-s2.1-pro-free';
  state.engine = 'fish-audio';
  state.model = 's2.1-pro-free';
  state.fishVoiceId = voiceId;
  state.voiceProfileReady = true;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, provider: state.provider, model: state.model, voiceId, referencePath: reference }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
