const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { VoicePipeline } = require('./voice-pipeline');
const { Mark2Runtime } = require('../mark2-runtime');

let child = null;
let startWaiter = null;
const state = { running: false, ready: false, pid: null, platform: process.platform, wakeWord: 'ULTRON', culture: null, lastTranscript: null, lastHypothesis: null, lastResponse: null, lastError: null };
function status() { return { ...state, running: Boolean(child && !child.killed) }; }

function resolveStart(result) {
  if (!startWaiter) return;
  const waiter = startWaiter;
  startWaiter = null;
  clearTimeout(waiter.timer);
  result.ok ? waiter.resolve(result) : waiter.reject(new Error(result.error || 'Voice listener failed to start.'));
}

function playAudioFile(audioPath) {
  const resolved = path.resolve(audioPath || '');
  if (!resolved || !fs.existsSync(resolved)) return false;
  if (process.platform !== 'win32') return false;
  const escaped = resolved.replace(/'/g, "''");
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${escaped}'`], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  return true;
}

function startVoiceDaemon() {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: 'Native voice daemon currently targets Windows.' });
  if (child && !child.killed) return Promise.resolve({ ok: state.ready, ...status(), error: state.ready ? undefined : 'Voice daemon process is running but not ready.' });
  const script = path.join(__dirname, 'windows-listener.ps1');
  if (!fs.existsSync(script)) return Promise.resolve({ ok: false, error: 'Windows listener script is missing.' });

  const core = new Mark2Runtime();
  const pipeline = new VoicePipeline();
  child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  state.running = true; state.ready = false; state.pid = child.pid; state.lastError = null;

  const startup = new Promise((resolve, reject) => {
    startWaiter = { resolve, reject, timer: setTimeout(() => { startWaiter = null; reject(new Error('Voice listener did not report readiness within 8 seconds. Check microphone permissions/device.')); }, 8000) };
  });

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'listener_started') {
        state.ready = true; state.culture = event.culture || null;
        resolveStart({ ok: true, ...status(), culture: state.culture });
        continue;
      }
      if (event.type === 'error') {
        state.lastError = event.error || 'Windows speech recognition error.';
        state.ready = false;
        resolveStart({ ok: false, error: state.lastError, ...status() });
        continue;
      }
      if (event.type === 'hypothesis') { state.lastHypothesis = event.text; continue; }
      if (event.type !== 'transcript') continue;
      state.lastTranscript = event.text;
      pipeline.processTranscript(event.text, message => core.handleMessage(message)).then(result => {
        if (result?.result?.response) state.lastResponse = result.result.response;
        if (result?.result?.response && process.env.ULTRON_VOICE_AUTOPLAY !== 'false' && result?.audio?.path) {
          if (!playAudioFile(result.audio.path)) state.lastError = 'Generated voice audio could not be played.';
        }
        state.lastError = result?.error || state.lastError;
      }).catch(error => { state.lastError = error.message; });
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { state.lastError = String(chunk).trim(); });
  child.on('exit', (code, signal) => {
    state.running = false; state.ready = false; state.pid = null;
    if (code && code !== 0) state.lastError = `Listener exited with code ${code}${signal ? ` (${signal})` : ''}.`;
    resolveStart({ ok: false, error: state.lastError || 'Listener exited before becoming ready.' });
    child = null;
  });
  return startup;
}

function stopVoiceDaemon() {
  if (!child) return { ok: true, stopped: false, ...status() };
  child.kill(); child = null; state.running = false; state.ready = false; state.pid = null; return { ok: true, stopped: true, ...status() };
}
if (require.main === module) startVoiceDaemon().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { startVoiceDaemon, stopVoiceDaemon, voiceDaemonStatus: status };
