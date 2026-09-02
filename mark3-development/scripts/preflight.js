const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const projectRoot = path.resolve(root, '..');
const required = [
  'server.js',
  'core/config.js',
  'core/persistence.js',
  'core/memory.js',
  'core/workspace.js',
  'core/model-intelligence.js',
  'core/model-router.js',
  'core/planner.js',
  'core/verifier.js',
  'core/integrations.js',
  'core/tools.js',
  'core/assistant.js',
  'core/conversation.js',
  'core/proactive.js',
  'core/voice-orchestrator.js',
  'core/windows-voice.js',
  'scripts/start-mark3.mjs',
  'interface/index.html',
  'interface/style.css',
  'interface/app.js',
];
const sharedTransport = ['core/omniroute.js', 'core/voice/index.js', 'core/credentials/local-store.js'];

for (const rel of required) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) throw new Error(`Missing required Mark 3 file: ${rel}`);
}
for (const rel of sharedTransport) {
  const file = path.join(projectRoot, rel);
  if (!fs.existsSync(file)) throw new Error(`Missing shared transport file: ${rel}`);
}

const js = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (['node_modules', 'data', 'workspace', '.ultron'].includes(name)) continue;
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) walk(file);
    else if (/\.(js|cjs|mjs)$/.test(name)) js.push(file);
  }
}
walk(root);

for (const file of js) {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' }); }
  catch { throw new Error(`JavaScript syntax check failed: ${path.relative(root, file)}`); }
}

function hasRuntimeCoupling(text) {
  const startUnified = /(?:require\s*\(|import\s+[^;]*?from\s+|spawn\s*\([^,]+,\s*\[[^\]]*)['\"](?:\.\.\/)*scripts\/start-unified\.mjs['\"]/m;
  const parentCoreUsage = /\bconfig\.parentCore\b/;
  return startUnified.test(text) || parentCoreUsage.test(text);
}

for (const file of js) {
  const rel = path.relative(root, file);
  const text = fs.readFileSync(file, 'utf8');
  if (/github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}/.test(text)) {
    throw new Error(`Possible secret embedded in source: ${rel}`);
  }

  // This file necessarily contains the detector expressions themselves.
  // Never run the runtime-coupling detector against the detector source.
  if (rel !== path.join('scripts', 'preflight.js') && hasRuntimeCoupling(text)) {
    throw new Error(`Mark 2 runtime coupling detected in Mark 3 source: ${rel}`);
  }
}

const packageFile = path.join(root, 'package.json');
if (fs.existsSync(packageFile)) {
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const startScript = String(pkg?.scripts?.start || '');
  if (/start-unified\.mjs/i.test(startScript)) {
    throw new Error('Mark 3 package start script must not launch the Mark 2 unified runtime.');
  }
}

const config = require('../core/config');
if (process.env.ULTRON_MODEL_PROVIDER !== 'omniroute') throw new Error('Mark 3 must force ULTRON_MODEL_PROVIDER=omniroute.');
if (!config.voiceOutputDir.startsWith(config.projectRoot)) throw new Error('Mark 3 voice output must be anchored to the project root.');

console.log(`ULTRON Mark 3 preflight passed: ${required.length} Mark 3 files, ${sharedTransport.length} shared transport files and ${js.length} JavaScript files validated.`);
