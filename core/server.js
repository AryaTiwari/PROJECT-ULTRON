const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Mark2Runtime } = require('./mark2-runtime');
const { config } = require('./config');
const { snapshot } = require('./inspector');
const { execute, listTools } = require('./executor');
const voice = require('./voice');
const { maintenanceSnapshot, heal } = require('./maintenance-api');
const { startVoiceDaemon, stopVoiceDaemon, voiceDaemonStatus } = require('./voice/daemon');
const voiceConfig = require('./voice/config').config;

const execFileAsync = promisify(execFile);
const core = new Mark2Runtime();
const uiFile = path.resolve(__dirname, '..', 'interface-test', 'index.html');
const audioRoot = path.resolve(voiceConfig.outputDir);

function send(res, status, payload, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(typeof payload === 'string' || payload instanceof Buffer ? payload : JSON.stringify(payload)),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(typeof payload === 'string' || payload instanceof Buffer ? payload : JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', c => {
      raw += c;
      if (raw.length > 100000) reject(new Error('Request body too large.'));
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

async function playLocalAudio(file) {
  const resolved = path.resolve(file);
  if (!resolved.startsWith(audioRoot + path.sep) || !fs.existsSync(resolved)) throw new Error('Audio file not found.');
  if (process.platform !== 'win32') return { ok: false, error: 'Local direct playback currently targets Windows.' };
  const escaped = resolved.replace(/'/g, "''");
  const ps = `$p = New-Object System.Windows.Media.MediaPlayer; $p.Open([Uri]::new('${escaped}')); Start-Sleep -Milliseconds 500; $p.Play(); while ($p.NaturalDuration.HasTimeSpan -eq $false) { Start-Sleep -Milliseconds 100 }; Start-Sleep -Milliseconds ([int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 250); $p.Close()`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName PresentationCore; " + ps], { timeout: 120000, windowsHide: true, maxBuffer: 1024 * 1024 });
  return { ok: true, played: true, path: resolved };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (req.method === 'GET' && (req.url === '/' || req.url === '/test-ui')) return send(res, 200, fs.readFileSync(uiFile, 'utf8'), 'text/html; charset=utf-8');

    if (req.method === 'GET' && req.url.startsWith('/api/audio?')) {
      const q = new URL(req.url, 'http://127.0.0.1').searchParams;
      const requested = path.basename(q.get('path') || '');
      if (!requested) return send(res, 400, { ok: false, error: 'Audio path is required.' });
      const file = path.resolve(audioRoot, requested);
      if (!file.startsWith(audioRoot + path.sep) || !fs.existsSync(file)) return send(res, 404, { ok: false, error: 'Audio file not found.' });
      const ext = path.extname(file).toLowerCase();
      const type = ext === '.wav' ? 'audio/wav' : ext === '.ogg' ? 'audio/ogg' : 'audio/mpeg';
      const stat = fs.statSync(file);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' });
      return fs.createReadStream(file).pipe(res);
    }

    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, service: 'ultron-core', ...core.status(), runtime: 'mark2-test' });
    if (req.method === 'GET' && req.url === '/api/tools') return send(res, 200, { ok: true, tools: listTools() });
    if (req.method === 'GET' && req.url === '/api/inspect') return send(res, 200, { ok: true, ...(await snapshot(core)) });
    if (req.method === 'GET' && req.url === '/api/maintenance') return send(res, 200, { ok: true, ...(await maintenanceSnapshot(core)) });
    if (req.method === 'POST' && req.url === '/api/self-heal') return send(res, 200, await heal());
    if (req.method === 'GET' && req.url === '/api/voice/daemon') return send(res, 200, { ok: true, ...voiceDaemonStatus() });
    if (req.method === 'POST' && req.url === '/api/voice/daemon/start') return send(res, 200, await startVoiceDaemon());
    if (req.method === 'POST' && req.url === '/api/voice/daemon/stop') return send(res, 200, stopVoiceDaemon());
    if (req.method === 'POST' && req.url === '/api/tools/execute') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.name) return send(res, 400, { ok: false, error: 'Tool name is required.' });
      const result = await execute(body.name, body.input || {}, { confirmed: body.confirmed === true, source: body.source || 'interface' });
      return send(res, result.ok ? 200 : result.requires_confirmation ? 409 : 400, result);
    }
    if (req.method === 'POST' && req.url === '/api/tts') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!String(body.text || '').trim()) return send(res, 400, { ok: false, error: 'Text is required.' });
      const result = await voice.synthesize(body.text, { filename: body.filename, model: body.model, referenceId: body.reference_id, format: body.format });
      return send(res, 200, result);
    }
    if (req.method === 'POST' && req.url === '/api/tts/play') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!String(body.text || '').trim()) return send(res, 400, { ok: false, error: 'Text is required.' });
      const audio = await voice.synthesize(body.text, { filename: body.filename, model: body.model, referenceId: body.reference_id, format: body.format });
      const playback = await playLocalAudio(audio.path);
      return send(res, 200, { ...audio, playback });
    }
    if (req.method === 'POST' && req.url === '/api/audio/play') {
      const body = JSON.parse((await readBody(req)) || '{}');
      return send(res, 200, await playLocalAudio(body.path));
    }
    if (req.method === 'GET' && req.url === '/api/voice/status') return send(res, 200, { ok: true, ...voice.status(), daemon: voiceDaemonStatus() });
    if (req.method === 'POST' && req.url === '/api/chat') {
      const body = JSON.parse((await readBody(req)) || '{}');
      return send(res, 200, await core.handleMessage(body.message, { confirmed: body.confirmed === true, model: body.model, action: body.action || null, source: body.source || 'interface' }));
    }
    return send(res, 404, { ok: false, error: 'Not found.' });
  } catch (error) {
    return send(res, 500, { ok: false, error: error?.message || String(error) });
  }
});

server.listen(config.port, config.host, () => console.log(`ULTRON Core listening at http://${config.host}:${config.port}`));
