const fs = require('fs');
const { config } = require('./config');

async function getVoiceModel() {
  const exists = fs.existsSync(config.referencePath);
  return {
    _id: 'local-chatterbox-turbo',
    title: 'ULTRON Local Chatterbox Turbo',
    type: 'voice-clone',
    state: exists ? 'ready' : 'not-installed',
    visibility: 'local',
    author: { nickname: 'ULTRON' },
    description: exists ? 'Local Chatterbox Turbo zero-shot voice cloning using the configured ULTRON reference recording.' : 'Install the local Chatterbox Turbo voice engine and reference recording.'
  };
}

module.exports = { getVoiceModel };
