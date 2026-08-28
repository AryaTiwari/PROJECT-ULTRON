const fs = require('fs');
const { config } = require('./config');

async function getVoiceModel() {
  const exists = fs.existsSync(config.referencePath);
  return {
    _id: 'nvidia-magpie-zeroshot',
    title: 'ULTRON NVIDIA Magpie Zero-Shot Voice',
    type: 'voice-clone',
    state: exists ? 'reference-ready' : 'not-installed',
    visibility: 'remote',
    author: { nickname: 'NVIDIA' },
    description: exists ? 'Remote NVIDIA Magpie zero-shot TTS using the configured ULTRON reference recording.' : 'Install/configure the ULTRON reference recording before using voice cloning.'
  };
}

module.exports = { getVoiceModel };
