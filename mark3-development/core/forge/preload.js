// Loaded only by the Mark 3 server process. Forge installs two lightweight local
// read-only endpoints before server.js creates its HTTP server, then Operator Mode,
// Reel Intelligence, Reel Factory, Forge and Adaptive Intelligence wrap the normal assistant.
const http = require('http');

const originalCreateServer = http.createServer.bind(http);
http.createServer = (...args) => {
  const listenerIndex = args.findLastIndex((value) => typeof value === 'function');
  if (listenerIndex < 0) return originalCreateServer(...args);
  const normalListener = args[listenerIndex];
  args[listenerIndex] = async (req, res) => {
    try {
      const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && pathname === '/api/forge/status') {
        const data = require('./dashboard').payload();
        const payload = JSON.stringify(data);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(payload),
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(payload);
        return;
      }
      if (req.method === 'GET' && ['/forge', '/forge/', '/forge-dashboard'].includes(pathname)) {
        const payload = require('./dashboard').page();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(payload),
          'Cache-Control': 'no-store',
        });
        res.end(payload);
        return;
      }
    } catch (error) {
      if (!res.headersSent) {
        const payload = JSON.stringify({ ok: false, error: error.message });
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store' });
        res.end(payload);
        return;
      }
    }
    return normalListener(req, res);
  };
  return originalCreateServer(...args);
};

setImmediate(() => {
  try {
    const operator = require('../operator-bootstrap').install();
    console.log(`[Mark 3] Operator Mode ready; ${operator.status.ready.length} capability/capabilities executable now.`);
  } catch (error) {
    console.error(`[Mark 3] Operator Mode bootstrap failed: ${error.message}`);
  }

  try {
    const intel = require('../reel-intelligence-runtime').install();
    console.log(`[Mark 3] Reel Intelligence ready; trend=${intel.status.trendMode || 'refresh-on-demand'}, adaptive account-fit enabled.`);
  } catch (error) {
    console.error(`[Mark 3] Reel Intelligence bootstrap failed: ${error.message}`);
  }

  try {
    require('../reel-v2-runtime').install();
    console.log('[Mark 3] Reel Factory v2 premium finisher + final quality gate ready.');
  } catch (error) {
    console.error(`[Mark 3] Reel Factory v2 finishing bootstrap failed: ${error.message}`);
  }

  try {
    const reels = require('../reel-operator-bootstrap').install();
    const ready = reels.status.stockSourceReady && reels.status.ffmpeg.available;
    console.log(`[Mark 3] Reel Factory Operator ${ready ? 'ready' : 'installed with blocker'}; natural make-a-reel commands enabled.`);
  } catch (error) {
    console.error(`[Mark 3] Reel Factory bootstrap failed: ${error.message}`);
  }

  try {
    const result = require('./bootstrap').install();
    console.log(`[Mark 3] ULTRON Forge ready${result.recovered?.length ? `; recovered ${result.recovered.length} mission(s)` : ''}. Command Center: http://127.0.0.1:8790/forge`);
  } catch (error) {
    console.error(`[Mark 3] ULTRON Forge bootstrap failed: ${error.message}`);
  }

  try {
    const adaptive = require('../adaptive-bootstrap').install();
    console.log(`[Mark 3] Adaptive Intelligence ready; ${adaptive.status.totalObservations || 0} learned observation(s), approval-gated proposals enabled.`);
  } catch (error) {
    console.error(`[Mark 3] Adaptive Intelligence bootstrap failed: ${error.message}`);
  }
});
