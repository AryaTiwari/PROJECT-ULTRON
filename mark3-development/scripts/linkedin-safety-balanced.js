#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const envPath = path.resolve(__dirname, '..', '..', '.env');
const values = {
  ULTRON_M3_LINKEDIN_MIN_GAP_MS: '9000',
  ULTRON_M3_LINKEDIN_JITTER_MS: '4000',
  ULTRON_M3_LINKEDIN_BURST_MAX: '10',
  ULTRON_M3_LINKEDIN_BURST_WINDOW_MS: '600000',
  ULTRON_M3_LINKEDIN_HOURLY_MAX: '24',
  ULTRON_M3_LINKEDIN_DAILY_MAX: '75',
  ULTRON_M3_LINKEDIN_MISSION_TOOL_MAX: '12',
  ULTRON_M3_LINKEDIN_RATE_LIMIT_COOLDOWN_MS: '1800000',
  ULTRON_M3_LINKEDIN_ERROR_BACKOFF_MS: '600000',
  ULTRON_M3_LINKEDIN_DEEP_PROFILE_MAX: '8',
};

if (!fs.existsSync(envPath)) {
  console.error(`Root .env was not found: ${envPath}`);
  process.exitCode = 1;
} else {
  const source = fs.readFileSync(envPath, 'utf8');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const seen = new Set();
  const updated = lines.map((line) => {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    const key = match?.[1];
    if (!key || !Object.hasOwn(values, key)) return line;
    seen.add(key);
    return `${key}=${values[key]}`;
  });
  if (updated.length && updated[updated.length - 1] !== '') updated.push('');
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) updated.push(`${key}=${value}`);
  }
  fs.writeFileSync(envPath, updated.join(newline), { mode: 0o600 });
  try { fs.chmodSync(envPath, 0o600); } catch {}
  console.log('Applied the balanced LinkedIn safety profile to the root .env.');
  console.log('Limits are LinkedIn tool operations, not lead rows: 10/10 minutes, 24/hour, 75/24 hours; 9s base gap + up to 4s jitter.');
  console.log('A first 429 pauses for 30 minutes; repeated 429s within 24 hours escalate to 60, 120, then 240 minutes. Checkpoints still hard-lock immediately.');
}
