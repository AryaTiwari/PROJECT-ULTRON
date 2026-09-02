const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./core/config');
const assistant = require('./core/assistant');
const memory = require('./core/memory');
const workspace = require('./core/workspace');
const models = require('./core/model-intelligence');
const integrations = require('./core/integrations');
const web = require('./core/web');
const voice = require('./core/voice-orchestrator');
const { subscribe } = require('./core/events');
const proactive = require('./core/proactive');

const webRoot = path.join(config.root, 'interface');
const audioRoot = path.resolve(config.voiceOutputDir);
const sseClients = new Set();

fs.mkdirSync(audioRoot, { recursive: true });
subscribe((event) => {
  for (const res of sseClients) {
    try { res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); } catch {}
  }
});
proactive.start(config.proactiveIntervalMs);

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(payload);
}
function body(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 200000) reject(new Error('Request too large.')); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid JSON request.')); } });
    req.on('error', reject);
  });
}
function safePath(urlPath) {
  const clean = decodeURIComponent(new URL(urlPath, 'http://127.0.0.1').pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(webRoot, clean);
  return file.startsWith(`${webRoot}${path.sep}`) ? file : null;
}
function mimeType(file) {
  return { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg' }[path.extname(file).toLowerCase()] || 'application/octet-stream';
}
function serve(req, res) {
  const file = safePath(req.url || '/');
  const target = file && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(webRoot, 'index.html');
  if (!fs.existsSync(target)) return send(res, 404, { ok:false, error:'Interface not built.' });
  const stat = fs.statSync(target);
  res.writeHead(200, { 'Content-Type':mimeType(target), 'Content-Length':stat.size, 'Cache-Control':/\.(js|css)$/i.test(target)?'no-cache':'no-store' });
  fs.createReadStream(target).pipe(res);
}
function serveAudio(req, res) {
  const params = new URL(req.url, 'http://127.0.0.1').searchParams;
  const requested = path.basename(params.get('path') || '');
  if (!requested) return send(res, 400, { ok:false, error:'Audio path is required.' });
  const file = path.resolve(audioRoot, requested);
  if (!file.startsWith(`${audioRoot}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res,404,{ok:false,error:'Audio file not found.'});
  const stat = fs.statSync(file);
  res.writeHead(200, { 'Content-Type':mimeType(file), 'Content-Length':stat.size, 'Cache-Control':'no-store', 'Accept-Ranges':'bytes', 'Access-Control-Allow-Origin':'*' });
  fs.createReadStream(file).pipe(res);
}
function errorStatus(error) {
  const upstream = Number(error?.status || 0);
  if (upstream === 400) return 400;
  if ([401,403].includes(upstream)) return 502;
  if (upstream === 429) return 503;
  if (upstream >= 500 && upstream <= 599) return 502;
  return 500;
}

const server = http.createServer(async (req,res) => {
  try {
    if (req.method === 'OPTIONS') return send(res,204,'');
    if (req.method === 'GET' && req.url === '/api/health') {
      const router = await integrations.health();
      return send(res, router.ok ? 200 : 503, { ok:Boolean(router.ok), service:'ULTRON Mark 3', version:'3.0.0-beta.9', inference:router, web:web.status(), voice:voice.status(), pid:process.pid, port:config.port });
    }
    if (req.method === 'GET' && req.url === '/api/web/status') return send(res,200,{ok:true,...web.status()});
    if (req.method === 'POST' && req.url === '/api/web/fetch') {
      const data = await body(req);
      const page = await web.fetchPage(String(data.url || ''));
      return send(res,200,{ok:true,url:page.url,title:page.title,status:page.status,provider:page.provider,chars:page.text.length,truncated:page.truncated,primaryError:page.primaryError||null,preview:page.text.slice(0,1200)});
    }
    if (req.method === 'POST' && req.url === '/api/web/search') {
      const data = await body(req);
      const result = await web.searchWeb(String(data.query || ''),{limit:data.limit||5});
      return send(res,200,{ok:true,...result});
    }
    if (req.method === 'GET' && req.url === '/api/state') return send(res,200,{ ok:true, memory:memory.snapshot(), commitments:workspace.listCommitments({status:'open'}), projects:workspace.listProjects(), decisions:workspace.listDecisions() });
    if (req.method === 'GET' && req.url === '/api/models') return send(res,200,{ ok:true, ...(await models.intelligence()) });
    if (req.method === 'GET' && req.url === '/api/providers') return send(res,200,{ ok:true, ...(await integrations.providerHealthSnapshot()) });
    if (req.method === 'GET' && req.url === '/api/diagnostics/omniroute') {
      let catalog=null,catalogError=null;
      try { catalog=await models.catalog(); } catch(error) { catalogError=error instanceof Error?error.message:String(error); }
      const router=await integrations.health();
      return send(res,router.ok?200:503,{ ok:Boolean(router.ok), endpoint:config.omnirouteBase, router, providers:await integrations.providerHealthSnapshot(), catalog, catalogError, credential:{ envConfigured:Boolean(config.omnirouteEndpointKey), resolved:Boolean(await integrations.resolveOmniRouteApiKey()) } });
    }
    if (req.method === 'GET' && req.url === '/api/voice/status') return send(res,200,{ok:true,...voice.status()});
    if (req.method === 'POST' && req.url === '/api/voice/test') {
      const data=await body(req); const audio=await integrations.speak(String(data.text||'ULTRON Mark 3 voice online.')); const filename=path.basename(String(audio.path||''));
      return send(res,200,{ok:true,...audio,audioUrl:`/api/audio?path=${encodeURIComponent(filename)}`});
    }
    if (req.method === 'GET' && req.url.startsWith('/api/audio?')) return serveAudio(req,res);
    if (req.method === 'GET' && req.url === '/api/events') {
      res.writeHead(200,{ 'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform',Connection:'keep-alive','Access-Control-Allow-Origin':'*','X-Accel-Buffering':'no' });
      res.write('event: connected\ndata: {"ok":true}\n\n'); sseClients.add(res);
      const heartbeat=setInterval(()=>{try{res.write(': keepalive\n\n');}catch{}},20000);
      req.on('close',()=>{clearInterval(heartbeat);sseClients.delete(res);}); return;
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      const data=await body(req); return send(res,200,await assistant.handle(data.message,{model:data.model,history:data.history,taskType:data.taskType}));
    }
    if (req.method === 'POST' && req.url === '/api/memory') { const data=await body(req); return send(res,200,{ok:true,result:memory.remember(data)}); }
    if (req.method === 'POST' && req.url === '/api/commitments') { const data=await body(req); return send(res,200,{ok:true,commitment:workspace.createCommitment(data)}); }
    if (req.method === 'POST' && req.url === '/api/decisions') { const data=await body(req); return send(res,200,{ok:true,decision:workspace.recordDecision(data)}); }
    if (req.method === 'POST' && req.url === '/api/projects') { const data=await body(req); return send(res,200,{ok:true,project:workspace.upsertProject(data)}); }
    if (req.method === 'GET') return serve(req,res);
    return send(res,404,{ok:false,error:'Not found.'});
  } catch(error) {
    if (!res.headersSent) return send(res,errorStatus(error),{ok:false,error:error.message,status:error.status||null,failures:error.failures||undefined});
    try{res.end();}catch{}
  }
});
server.listen(config.port,config.host,()=>console.log(`ULTRON Mark 3 listening at http://${config.host}:${config.port} [PID ${process.pid}]`));
