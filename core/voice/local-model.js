const fs = require('fs');
const { config } = require('./config');

async function getVoiceModel() {
  const exists = fs.existsSync(config.referencePath);
  return {
    _id: 'local-openvoice-v2',
    title: 'ULTRON Local OpenVoice V2',
    type: 'voice-clone',
    state: exists ? 'ready' : 'not-installed',
    visibility: 'local',
    author: { nickname: 'ULTRON' },
    description: exists ? 'Local OpenVoice V2 voice clone using the configured ULTRON reference recording.' : 'Install the local OpenVoice V2 voice engine and reference recording.'
  };
}

module.exports = { getVoiceModel };
