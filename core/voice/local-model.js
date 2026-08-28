const fs = require('fs');
const { config } = require('./config');

async function getVoiceModel() {
  const exists = fs.existsSync(config.referencePath);
  return {
    _id: 'nvidia-magpie-zeroshot',
    title: 'ULTRON NVIDIA Magpie ZeroShot',
    type: 'voice-clone',
    state: exists ? 'ready' : 'not-installed',
    visibility: 'remote',
    author: { nickname: 'NVIDIA' },
    description: exists
      ? 'Remote NVIDIA Magpie TTS Zeroshot voice cloning using the configured ULTRON reference recording.'
      : 'Prepare the ULTRON reference recording with npm run core:voice-setup.',
  };
}

module.exports = { getVoiceModel };
