const http = require('http');
const fs = require('fs');
const path = require('path');
const { Mark2Runtime } = require('./mark2-runtime');
const { config } = require('./config');
const { snapshot } = require('./inspector');
const { execute, listTools } = require('./executor');
const voice = require('./voice');
const { maintenanceSnapshot, heal } = require('./maintenance-api');
const { startVoiceDaemon, stopVoiceDaemon, voiceDaemonStatus } = require('./voice/daemon');

const core = new Mark2Runtime();
const uiFile = path.resolve(__dirname, '..', 'interface-test', 'index.html');

function send(res, status, payload, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; if (raw.length > 100_000) reject(new Error('Request body too large.')); });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (req.method === 'GET' && (req.url === '/' || req.url === '/test-ui')) {
    try { return send(res, 200, fs.readFileSync(uiFile, 'utf8'), 'text/html; charset=utf-8'); }
    catch (error) { return send(res, 500, { ok: false, error: error.message }); }
  }
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, service: 'ultron-core', ...core.status(), runtime: 'mark2-test' });
  if (req.method === 'GET' && req.url === '/api/tools') return send(res, 200, { ok: true, tools: listTools() });
  if (req.method === 'GET' && req.url === '/api/inspect') { try { return send(res, 200, { ok: true, ...(await snapshot(core)) }); } catch (error) { return send(res, 500, { ok: false, error: error?.message || String(error) }); } }
  if (req.method === 'GET' && req.url === '/api/maintenance') { try { return send(res, 200, { ok: true, ...(await maintenanceSnapshot(core)) }); } catch (error) { return send(res, 500, { ok: false, error: error?.message || String(error) }); } }
  if (req.method === 'POST' && req.url === '/api/self-heal') { try { return send(res, 200, await heal()); } catch (error) { return send(res, 500, { ok: false, error: error?.message || String(error) }); } }
  if (req.method === 'GET' && req.url === '/api/voice/daemon') return send(res, 200, { ok: true, ...voiceDaemonStatus() });
  if (req.method === 'POST' && req.url === '/api/voice/daemon/start') { try { return send(res, 200, await startVoiceDaemon()); } catch (error) { return send(res, 500, { ok: false, error: error?.message || String(error) }); } }
  if (req.method === 'POST' && req.url === '/api/voice/daemon/stop') return send(res, 200, stopVoiceDaemon());
  if (req.method === 'POST' && req.url === '/api/tools/execute') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.name) return send(res, 400, { ok: false, error: 'Tool name is required.' });
      const result = await execute(body.name, body.input || {}, { confirmed: body.confirmed === true, source: body.source || 'interface' });
      return send(res, result.ok ? 200 : result.requires_confirmation ? 409 : 400, result);
    } catch (error) { return send(res, 500, { ok: false, error: error?.message || String(error) }); }
  }
  if (req.method === 'POST' && req.url === '/api/tts') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!String(body.text || '').trim()) return send(res, 400, { ok: false, error: 'Text is required.' });
      return send(res, 200, await voice.synthesize(body.text, { filename: body.filename, model: body.model, referenceId: body.reference_id, format: body.format }));
    } catch (error) { return send(res, 502, { ok: false, error: error?.message || String(error) }); }
  }
  if (req.method === 'GET' && req.url === '/api/voice/status') return send(res, 200, { ok: true, ...voice.status(), daemon: voiceDaemonStatus() });
  if (req.method === 'POST' && req.url === '/api/chat') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = await core.handleMessage(body.message, { confirmed: body.confirmed === true, model: body.model, action: body.action || null, source: body.source || 'interface' });
      return send(res, result.ok ? 200 : 502, result);
    } catch (error) { return send(res, 500, { ok: false, error: error?.message || String(error) }); }
  }
  return send(res, 404, { ok: false, error: 'Not found.' });
});

server.listen(config.port, config.host, () => console.log(`ULTRON Core listening at http://${config.host}:${config.port}`));
