// Loaded only by the Mark 3 server process. Forge installs two lightweight local
// read-only endpoints before server.js creates its HTTP server, then wraps the
// normal assistant after server modules finish loading.
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
    const result = require('./bootstrap').install();
    console.log(`[Mark 3] ULTRON Forge ready${result.recovered?.length ? `; recovered ${result.recovered.length} mission(s)` : ''}. Command Center: http://127.0.0.1:8790/forge`);
  } catch (error) {
    console.error(`[Mark 3] ULTRON Forge bootstrap failed: ${error.message}`);
  }
});
