const { config } = require('./config');

async function getVoiceModel() {
  if (!config.apiKey) throw new Error('Fish Audio API key is not configured.');
  const response = await fetch(`https://api.fish.audio/model/${encodeURIComponent(config.referenceId)}`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok) throw new Error(`Fish Audio model lookup HTTP ${response.status}: ${raw.slice(0, 500)}`);
  return data;
}

module.exports = { getVoiceModel };
