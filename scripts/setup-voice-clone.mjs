import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FishAudioClient } from 'fish-audio';
import credentials from '../core/credentials/local-store.js';

const PROJECT_ROOT = process.cwd();
const STATE_DIR = path.join(PROJECT_ROOT, '.ultron');
const STATE_FILE = path.join(STATE_DIR, 'voice-clone.json');
const SAMPLE_FILE = path.join(STATE_DIR, 'voice', 'ultron-reference.mp3');

const SAMPLE_URL = 'https://raw.githubusercontent.com/AryaTiwari/Interface1/main/Ultron-2026-08-27-11-05-%5Bsoft%5D-I-was-designed-to-%5Bemphasis%5D-save-the-wor.mp3';
const SAMPLE_BLOB_SHA = '8a0b5bd362b341fa088cb3ed579c792909e5332c';
const DEFAULT_TITLE = 'ULTRON Personal Voice';
const DEFAULT_DESCRIPTION = 'ULTRON private voice clone created from the Interface1 reference recording.';

async function loadFishKey() {
  if (String(process.env.FISH_API_KEY || '').trim()) return String(process.env.FISH_API_KEY).trim();
  try {
    const saved = await credentials.load();
    return String(saved.FISH_API_KEY || '').trim();
  } catch {
    return '';
  }
}

async function ensureSample() {
  await fs.mkdir(path.dirname(SAMPLE_FILE), { recursive: true });
  try {
    const existing = await fs.readFile(SAMPLE_FILE);
    if (existing.length > 0) return existing;
  } catch {}
  const response = await fetch(SAMPLE_URL, { headers: { 'User-Agent': 'PROJECT-ULTRON-voice-clone' } });
  if (!response.ok) throw new Error(`Unable to download ULTRON reference audio: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(SAMPLE_FILE, buffer);
  return buffer;
}

async function loadState() {
  try { return JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); } catch { return null; }
}

async function main() {
  const existing = await loadState();
  if (existing?.voiceId) {
    console.log(JSON.stringify({ ok: true, reused: true, voiceId: existing.voiceId, sample: existing.sampleUrl }, null, 2));
    return;
  }

  const apiKey = await loadFishKey();
  if (!apiKey) throw new Error('No FISH_API_KEY found in ULTRON .env or encrypted Windows credential vault.');

  const sample = await ensureSample();
  const digest = createHash('sha256').update(sample).digest('hex');
  const client = new FishAudioClient({ apiKey });
  const audioFile = new File([sample], 'ultron-reference.mp3', { type: 'audio/mpeg' });
  const response = await client.voices.ivc.create({
    title: process.env.ULTRON_VOICE_CLONE_TITLE || DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    voices: [audioFile],
    visibility: 'private',
  });
  const voiceId = response?._id || response?.id;
  if (!voiceId) throw new Error('Fish Audio returned no voice ID.');

  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify({
    provider: 'fish',
    voiceId,
    title: response?.title || DEFAULT_TITLE,
    sampleUrl: SAMPLE_URL,
    sampleRepository: 'AryaTiwari/Interface1',
    samplePath: SAMPLE_FILE,
    sampleBlobSha: SAMPLE_BLOB_SHA,
    sampleSha256: digest,
    createdAt: new Date().toISOString(),
    visibility: 'private',
  }, null, 2));

  console.log(JSON.stringify({ ok: true, created: true, voiceId, title: response?.title || DEFAULT_TITLE, sample: SAMPLE_FILE }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
