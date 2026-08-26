const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { VoicePipeline } = require('./voice-pipeline');
const { UltronCore } = require('../ultron-core');
const { synthesize } = require('./fish-tts');

let child = null;
let lastError = null;
const state = { running: false, pid: null, platform: process.platform, wakeWord: 'ULTRON', lastTranscript: null, lastResponse: null, lastError: null };

function status() { return { ...state, running: Boolean(child && !child.killed) }; }

function startVoiceDaemon() {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: 'Native voice daemon currently targets Windows.' });
  if (child && !child.killed) return Promise.resolve({ ok: true, ...status() });

  const script = path.join(__dirname, 'windows-listener.ps1');
  if (!fs.existsSync(script)) return Promise.resolve({ ok: false, error: 'Windows listener script is missing.' });

  const core = new UltronCore();
  const pipeline = new VoicePipeline();
  child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  state.running = true;
  state.pid = child.pid;

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type !== 'transcript') continue;
      state.lastTranscript = event.text;
      pipeline.processTranscript(event.text, message => core.handleMessage(message)).then(async result => {
        if (result?.audio?.path) {
          state.lastResponse = result.result?.response || null;
          if (process.platform === 'win32') {
            spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath '${String(result.audio.path).replace(/'/g, "''")}'`], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
          }
        } else if (result?.result?.response) {
          state.lastResponse = result.result.response;
          if (process.env.ULTRON_VOICE_AUTOPLAY !== 'false') {
            try {
              const audio = await synthesize(result.result.response);
              spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath '${String(audio.path).replace(/'/g, "''")}'`], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
            } catch (error) { state.lastError = error.message; }
          }
        }
        state.lastError = result?.error || state.lastError;
      }).catch(error => { state.lastError = error.message; });
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { lastError = String(chunk).trim(); state.lastError = lastError; });
  child.on('exit', (code, signal) => { state.running = false; state.pid = null; if (code && code !== 0) state.lastError = `Listener exited with code ${code}${signal ? ` (${signal})` : ''}.`; child = null; });
  return Promise.resolve({ ok: true, ...status() });
}

function stopVoiceDaemon() {
  if (!child) return { ok: true, stopped: false, ...status() };
  child.kill();
  child = null;
  state.running = false;
  state.pid = null;
  return { ok: true, stopped: true, ...status() };
}

if (require.main === module) {
  startVoiceDaemon().then(result => { console.log(JSON.stringify(result)); }).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { startVoiceDaemon, stopVoiceDaemon, voiceDaemonStatus: status };
