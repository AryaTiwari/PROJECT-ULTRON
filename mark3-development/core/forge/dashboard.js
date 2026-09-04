const fs = require('fs');
const path = require('path');
const supervisor = require('./supervisor');
const governor = require('./model-governor');

function workspaceSummary(workspace) {
  const root = String(workspace || '');
  const result = { exists: false, topLevel: [], package: null, runnable: false, runCommand: null, sourceFiles: 0 };
  if (!root || !fs.existsSync(root)) return result;
  result.exists = true;
  try {
    result.topLevel = fs.readdirSync(root, { withFileTypes: true }).slice(0, 40).map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'dir' : 'file',
    }));
    const walk = (dir, depth = 0) => {
      if (depth > 3 || result.sourceFiles > 500) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (['.git', 'node_modules', '.ultron'].includes(entry.name)) continue;
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(target, depth + 1);
        else if (/\.(?:js|jsx|ts|tsx|css|html|json)$/i.test(entry.name)) result.sourceFiles += 1;
      }
    };
    walk(root);
  } catch {}
  const packageFile = path.join(root, 'package.json');
  if (fs.existsSync(packageFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
      const scripts = pkg.scripts || {};
      const runScript = ['dev', 'start', 'serve'].find((name) => typeof scripts[name] === 'string');
      result.package = { name: pkg.name || null, scripts };
      result.runnable = Boolean(runScript);
      result.runCommand = runScript ? `npm run ${runScript}` : null;
    } catch {}
  }
  return result;
}

function payload() {
  const state = supervisor.status();
  if (!state.available) return { ok: true, available: false };
  const mission = state.mission;
  const jobs = Array.isArray(state.jobs) ? state.jobs : [];
  const counts = {};
  for (const job of jobs) counts[job.status] = (counts[job.status] || 0) + 1;
  return {
    ok: true,
    available: true,
    running: Boolean(state.running),
    mission: {
      id: mission.id,
      objective: mission.objective,
      status: mission.status,
      progress: mission.progress || {},
      workspace: mission.workspace,
      createdAt: mission.createdAt || null,
      updatedAt: mission.updatedAt || null,
      repairCycles: mission.repairCycles || 0,
      automation: Boolean(mission.automation),
    },
    usage: state.usage || { calls: 0, totalTokens: 0 },
    modelHealth: governor.status(),
    counts,
    jobs: jobs.map((job) => ({
      id: job.id,
      title: job.title || job.id,
      kind: job.kind || null,
      worker: job.worker || null,
      status: job.status,
      attempts: job.attempts || 0,
      error: job.error || job.blockedReason || job.pausedReason || null,
      dependsOn: job.dependsOn || [],
      changedFiles: Array.isArray(job.output?.changedFiles) ? job.output.changedFiles : [],
    })),
    workspace: workspaceSummary(mission.workspace),
  };
}

function page() {
  const css = [
    ':root{color-scheme:dark;--bg:#080a0f;--panel:#11151d;--panel2:#171c26;--line:#252c39;--text:#f4f6fb;--muted:#929bad;--good:#62d28f;--warn:#f0bf62;--bad:#ef6b73;--accent:#9daeff}',
    '*{box-sizing:border-box}',
    'body{margin:0;background:radial-gradient(circle at 20% -10%,#1b2340 0,transparent 35%),var(--bg);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text)}',
    'main{max-width:1180px;margin:auto;padding:32px 22px 60px}',
    '.top{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:22px}.eyebrow{font-size:12px;letter-spacing:.18em;color:var(--accent);font-weight:800}.title{font-size:34px;margin:5px 0 3px}.muted{color:var(--muted)}',
    '.live{font-size:12px;padding:7px 10px;border:1px solid var(--line);border-radius:999px;background:#0e1219}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}',
    '.card{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:16px;padding:17px;box-shadow:0 12px 40px rgba(0,0,0,.18)}.metric{font-size:28px;font-weight:800;margin-top:6px}.label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}.wide{grid-column:1/-1}.half{grid-column:span 2}',
    '.hero-title{font-size:24px;margin:7px 0}.explain{font-size:15px;line-height:1.55;margin:7px 0 0;color:#d4d9e3}.progress{height:11px;background:#080b10;border:1px solid var(--line);border-radius:99px;overflow:hidden;margin:14px 0 7px}.bar{height:100%;background:linear-gradient(90deg,#788cff,#b98cff);width:0;transition:width .4s ease}',
    '.status{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:700}.dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}.running .dot,.completed .dot{background:var(--good)}.failed .dot,.partial .dot{background:var(--bad)}.paused_inference .dot,.paused .dot{background:var(--warn)}',
    '.jobs{display:grid;gap:8px;margin-top:13px}.job{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;background:#0c1016;border:1px solid var(--line);border-radius:11px;padding:11px 12px}.job-title{font-size:14px;font-weight:700}.job-meta{font-size:12px;color:var(--muted);margin-top:3px}.pill{font-size:11px;font-weight:800;padding:5px 8px;border-radius:999px;background:#202633;color:#cbd2df}.pill.completed{color:var(--good)}.pill.running{color:#b8c4ff}.pill.failed,.pill.blocked{color:var(--bad)}.pill.paused{color:var(--warn)}',
    '.files{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}.file{font-size:12px;background:#0b0e14;border:1px solid var(--line);border-radius:8px;padding:6px 8px;color:#bdc5d3}.command{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:#090c11;border:1px solid var(--line);border-radius:9px;padding:10px 12px;margin-top:10px;color:#dbe0ec;word-break:break-all}.error{color:var(--bad);font-size:12px;margin-top:4px;line-height:1.4}.empty{padding:70px 20px;text-align:center;color:var(--muted)}',
    '.action{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px}.btn{border:1px solid #6e7ee8;background:#5969d7;color:white;border-radius:10px;padding:10px 14px;font-weight:800;cursor:pointer}.btn:disabled{opacity:.5;cursor:wait}.notice{border-left:3px solid var(--warn);padding:10px 12px;background:#15130d;border-radius:8px;font-size:14px;line-height:1.5}.goodnotice{border-left-color:var(--good);background:#0d1511}.small{font-size:12px;color:var(--muted)}',
    '@media(max-width:800px){.grid{grid-template-columns:1fr 1fr}.half{grid-column:1/-1}}@media(max-width:520px){.grid{grid-template-columns:1fr}.half{grid-column:1}.top{align-items:flex-start;flex-direction:column}.title{font-size:28px}}',
  ].join('');

  const script = [
    "const esc=(v)=>String(v??'').replace(/[&<>\"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));",
    "function shortError(v){const s=String(v||'');if(/410|end of life|no longer available/i.test(s))return 'A coding model was retired by NVIDIA.';if(/503|ResourceExhausted|request limit/i.test(s))return 'A free coding model is temporarily overloaded.';if(/timed out|timeout/i.test(s))return 'A free coding model took too long to respond.';if(/json object|invalid json/i.test(s))return 'The coding model returned the wrong response format.';if(/dependency-not-satisfied/i.test(s))return 'Waiting for an earlier build step to succeed.';return s.slice(0,220);}",
    "function jobCard(j,problem){return '<div class=\"job\"><div><div class=\"job-title\">'+esc(j.title)+'</div>'+(problem?'<div class=\"error\">'+esc(shortError(j.error||'Waiting on dependency'))+'</div>':'<div class=\"job-meta\">'+esc(j.kind||j.worker||'specialist')+(j.changedFiles&&j.changedFiles.length?' · '+j.changedFiles.length+' files changed':'')+'</div>')+'</div><span class=\"pill '+esc(j.status)+'\">'+(problem?esc(j.status):'done')+'</span></div>';}",
    "function projectName(m){return /crm|creator lead|lead command center/i.test(m.objective||'')?'Elevate Creator CRM':String(m.objective||'Forge mission').slice(0,80);}",
    "function explanation(data){const s=data.mission.status;if(data.running)return 'Ultron is actively building the project right now. Completed work is saved after every job.';if(s==='paused_inference')return 'The build is paused because the free cloud coding models are temporarily unavailable. Your completed work is saved and can be resumed.';if(s==='partial'||s==='failed')return 'The build stopped because one or more jobs failed. Completed work is still saved; retry only the failed parts.';if(s==='completed')return 'The build finished and passed Forge completion checks.';return 'The mission is saved and waiting for its next executable step.';}",
    "function nextAction(data){const s=data.mission.status;if(s==='paused_inference'||s==='partial'||s==='failed')return 'Resume Forge';return '';}",
    "async function resume(btn){btn.disabled=true;btn.textContent='Resuming…';try{await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:'Resume Forge',inputMode:'chat'})});await new Promise(r=>setTimeout(r,900));await refresh();}finally{btn.disabled=false;btn.textContent='Resume Forge';}}",
    "function render(data){const content=document.getElementById('content');if(!data.available){content.className='empty';content.innerHTML='<div class=\"card wide empty\">No Forge mission exists yet.</div>';return;}const m=data.mission,p=m.progress||{},u=data.usage||{},ws=data.workspace||{};const active=data.jobs.find((j)=>j.status==='running');const problems=data.jobs.filter((j)=>['failed','blocked','paused','blocked_approval'].includes(j.status));const completed=data.jobs.filter((j)=>j.status==='completed');const remaining=Math.max(0,(p.total||data.jobs.length)-(p.completed||completed.length));const runState=data.running?'running now':m.status;const appText=ws.runnable?'Runnable app detected':'Not built enough to run yet';const completedHtml=completed.slice(-7).reverse().map((j)=>jobCard(j,false)).join('')||'<div class=\"muted\">No build step completed yet.</div>';const failedHtml=problems.slice(0,7).map((j)=>jobCard(j,true)).join('')||'<div class=\"muted\">No blocked or failed jobs right now.</div>';const filesHtml=(ws.topLevel||[]).filter(f=>f.name!=='.git').slice(0,30).map((f)=>'<span class=\"file\">'+(f.type==='dir'?'▸ ':'• ')+esc(f.name)+'</span>').join('')||'<span class=\"muted\">No usable app files generated yet.</span>';const action=nextAction(data);let html='';",
    "html+='<section class=\"card wide\"><div class=\"label\">Current project</div><h2 class=\"hero-title\">'+esc(projectName(m))+'</h2><div class=\"status '+esc(m.status)+'\"><span class=\"dot\"></span>'+esc(runState)+'</div><p class=\"explain\">'+esc(explanation(data))+'</p><div class=\"progress\"><div class=\"bar\" style=\"width:'+Number(p.percent||0)+'%\"></div></div><div class=\"muted\">'+(p.completed||0)+' of '+(p.total||data.jobs.length)+' build jobs complete · '+remaining+' remaining</div>'+(action?'<div class=\"action\"><button class=\"btn\" onclick=\"resume(this)\">Resume Forge</button><span class=\"small\">Retries only unfinished/failed work; completed jobs stay saved.</span></div>':'')+'</section>';",
    "html+='<section class=\"card\"><div class=\"label\">Progress</div><div class=\"metric\">'+(p.percent||0)+'%</div></section><section class=\"card\"><div class=\"label\">AI calls</div><div class=\"metric\">'+(u.calls||0)+'</div></section><section class=\"card\"><div class=\"label\">Tokens used</div><div class=\"metric\">'+Number(u.totalTokens||0).toLocaleString()+'</div></section><section class=\"card\"><div class=\"label\">CRM app</div><div class=\"metric\" style=\"font-size:17px;margin-top:10px\">'+esc(appText)+'</div></section>';",
    "html+='<section class=\"card half\"><div class=\"label\">What Ultron is doing</div><div style=\"font-size:20px;font-weight:800;margin-top:9px\">'+(active?esc(active.title):'No active build job')+'</div>'+(active?'<div class=\"muted\" style=\"margin-top:5px\">'+esc(active.kind||active.worker||'specialist')+' · attempt '+(active.attempts||0)+'</div>':'<div class=\"notice\" style=\"margin-top:12px\">'+esc(explanation(data))+'</div>')+'</section>';",
    "html+='<section class=\"card half\"><div class=\"label\">What actually exists</div><div class=\"metric\" style=\"font-size:20px\">'+Number(ws.sourceFiles||0)+' source/config files</div><div class=\"muted\" style=\"margin-top:8px\">'+(ws.runnable?'The project has a run command.':'The CRM is not runnable yet; planning/setup output is not the finished app.')+'</div></section>';",
    "html+='<section class=\"card half\"><div class=\"label\">Completed ('+completed.length+')</div><div class=\"jobs\">'+completedHtml+'</div></section><section class=\"card half\"><div class=\"label\">Problems ('+problems.length+')</div><div class=\"jobs\">'+failedHtml+'</div></section>';",
    "html+='<section class=\"card wide\"><div class=\"label\">Generated project files</div><div class=\"files\">'+filesHtml+'</div>'+(ws.runCommand?'<div class=\"muted\" style=\"margin-top:12px\">When the CRM is ready, run it from the workspace with:</div><div class=\"command\">'+esc(ws.runCommand)+'</div>':'')+'<details style=\"margin-top:14px\"><summary class=\"small\">Technical details</summary><div class=\"command\">'+esc(m.workspace)+'</div><div class=\"small\">Mission '+esc(m.id)+'</div></details></section>';",
    "content.className='grid';content.innerHTML=html;}",
    "async function refresh(){try{const r=await fetch('/api/forge/status',{cache:'no-store'});const data=await r.json();render(data);document.getElementById('updated').textContent='Live · updated '+new Date().toLocaleTimeString();}catch(e){document.getElementById('updated').textContent='Disconnected';}}refresh();setInterval(refresh,3000);",
  ].join('\n');

  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />',
    '<title>ULTRON Forge</title><style>', css, '</style></head><body><main>',
    '<div class="top"><div><div class="eyebrow">ULTRON MARK 3</div><h1 class="title">Forge Command Center</h1><div class="muted">See what Ultron is building, what is actually finished, and what needs action.</div></div><div class="live" id="updated">Connecting…</div></div>',
    '<div id="content" class="empty">Loading Forge mission…</div>',
    '</main><script>', script, '</script></body></html>',
  ].join('');
}

module.exports = { payload, page, workspaceSummary };
