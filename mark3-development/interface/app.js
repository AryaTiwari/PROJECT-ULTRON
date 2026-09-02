const API='';
const CHAT_TIMEOUT_MS=120000;
const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition||null;
const state={
  status:'IDLE',model:'AUTO ROUTER',events:[],messages:[],audioQueue:[],playing:false,currentAudio:null,
  voiceEnabled:true,streamingNode:null,chatOpen:localStorage.getItem('ultron-m3-chat-open')==='1',
  micSupported:Boolean(SpeechRecognition),recognition:null,listening:false,pendingSpeech:'',interimSpeech:'',
};

const app=document.querySelector('#app');
app.innerHTML=`
<div class="m3-shell ${state.chatOpen?'chat-open':''}">
  <header class="topbar">
    <div class="brand">
      <div class="brand-mark">U3</div>
      <div><div class="brand-title">ULTRON</div><div class="brand-sub">MARK 3 · VOICE OPERATING INTELLIGENCE</div></div>
    </div>
    <div class="mode-chip"><span class="mode-wave"><i></i><i></i><i></i></span><span>VOICE PRIMARY</span></div>
    <div class="top-actions">
      <button id="chatToggle" class="utility-button" type="button">CHAT</button>
      <button id="voiceToggle" class="utility-button voice-toggle" type="button" aria-pressed="false">AUDIO ON</button>
      <div class="status"><span class="dot"></span><span id="statusText">ONLINE // IDLE</span></div>
    </div>
  </header>

  <main class="workspace">
    <aside class="activity">
      <div class="panel-kicker">SYSTEM TRACE</div>
      <div class="activity-title">LIVE ACTIVITY</div>
      <div id="activityList"></div>
    </aside>

    <section class="voice-stage" aria-label="ULTRON voice interface">
      <div class="globe-wrap" id="globeWrap">
        <canvas id="globe" class="globe" width="680" height="680"></canvas>
        <div class="glow"></div><div class="ring r1"></div><div class="ring r2"></div>
        <button id="voiceOrb" class="voice-orb" type="button" aria-label="Talk to ULTRON">
          <span class="orb-halo h1"></span><span class="orb-halo h2"></span>
          <span class="orb-core">
            <svg class="mic-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a4 4 0 0 0 4-4V6a4 4 0 1 0-8 0v5a4 4 0 0 0 4 4Zm7-4a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V20H8.5a1 1 0 1 0 0 2h7a1 1 0 1 0 0-2H13v-2.08A7 7 0 0 0 19 11Z"/></svg>
          </span>
        </button>
        <div class="hud">
          <div class="tl"><span>LINK</span><span id="hudState">STABLE</span></div>
          <div class="tr"><span>MODEL</span><span id="hudModel">AUTO ROUTER</span></div>
          <div class="bl"><span>LATENCY</span><span id="hudLatency">—</span></div>
          <div class="br"><span>MEMORY</span><span id="hudMemory">—</span></div>
        </div>
      </div>
      <div class="voice-copy">
        <div id="voiceEyebrow" class="voice-eyebrow">${state.micSupported?'TAP THE CORE TO SPEAK':'MIC INPUT UNAVAILABLE'}</div>
        <div id="voicePrompt" class="voice-prompt">${state.micSupported?'I’m listening when you are.':'Use the chat backup on this browser.'}</div>
        <div id="voiceInterim" class="voice-interim"></div>
        <div id="voiceCaption" class="voice-caption">ULTRON is online.</div>
        <div class="voice-shortcut">${state.micSupported?'Click core · Ctrl + Space':'Chat remains fully available'}</div>
      </div>
    </section>

    <section class="chat transcript-panel" aria-label="Chat backup and transcript">
      <div class="chat-head"><div><span class="panel-kicker">BACKUP SURFACE</span><strong>TRANSCRIPT</strong></div><button id="chatClose" type="button" class="icon-button" aria-label="Close chat">×</button></div>
      <div id="messages" class="messages"></div>
      <div class="composer"><textarea id="input" placeholder="Type if you’d rather not speak…" aria-label="Message"></textarea><button id="send">SEND</button></div>
    </section>
  </main>

  <footer class="bottom">
    <div class="telemetry">
      <div class="telemetry-item"><span class="telemetry-label">MODEL</span><span class="telemetry-value" id="model">AUTO ROUTER</span></div>
      <div class="telemetry-item"><span class="telemetry-label">TASK</span><span class="telemetry-value" id="task">READY</span></div>
      <div class="telemetry-item"><span class="telemetry-label">MEMORY</span><span class="telemetry-value" id="memory">0</span></div>
      <div class="telemetry-item"><span class="telemetry-label">COMMITMENTS</span><span class="telemetry-value" id="commitments">0</span></div>
    </div>
    <div class="hint">VOICE → UNDERSTAND → ACT → VERIFY</div>
  </footer>
</div>`;

const els={
  shell:document.querySelector('.m3-shell'),statusText:document.querySelector('#statusText'),hudState:document.querySelector('#hudState'),
  hudModel:document.querySelector('#hudModel'),hudLatency:document.querySelector('#hudLatency'),hudMemory:document.querySelector('#hudMemory'),
  model:document.querySelector('#model'),task:document.querySelector('#task'),memory:document.querySelector('#memory'),commitments:document.querySelector('#commitments'),
  activityList:document.querySelector('#activityList'),messages:document.querySelector('#messages'),input:document.querySelector('#input'),send:document.querySelector('#send'),
  voiceToggle:document.querySelector('#voiceToggle'),chatToggle:document.querySelector('#chatToggle'),chatClose:document.querySelector('#chatClose'),voiceOrb:document.querySelector('#voiceOrb'),
  voiceEyebrow:document.querySelector('#voiceEyebrow'),voicePrompt:document.querySelector('#voicePrompt'),voiceInterim:document.querySelector('#voiceInterim'),voiceCaption:document.querySelector('#voiceCaption'),
};

function escapeHtml(value){return String(value||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function compact(value,max=220){const text=String(value||'').replace(/\s+/g,' ').trim();return text.length>max?`${text.slice(0,max-1)}…`:text;}
function renderEvents(){els.activityList.innerHTML=state.events.slice(-10).reverse().map(e=>`<div class="event"><div class="event-state">${escapeHtml(e.type.replaceAll('_',' '))}</div><div class="event-label">${escapeHtml(e.label||e.reason||e.message||e.error||e.kind||(e.primary?`PRIMARY · ${e.primary}`:'')||'')}</div>${e.provider?`<div class="event-tool">${escapeHtml(e.provider)}</div>`:''}${e.tool?`<div class="event-tool">${escapeHtml(e.tool)}</div>`:''}${e.model?`<div class="event-tool">${escapeHtml(e.model)}</div>`:''}</div>`).join('');}
function addMessage(role,text,meta=''){const node=document.createElement('div');node.className=`msg ${role}`;node.textContent=text;els.messages.appendChild(node);if(meta)addMeta(meta);els.messages.scrollTop=els.messages.scrollHeight;return node;}
function addMeta(meta){const m=document.createElement('div');m.className='msg meta';m.textContent=meta;els.messages.appendChild(m);els.messages.scrollTop=els.messages.scrollHeight;return m;}
function setCaption(text){const value=compact(text,360);if(value)els.voiceCaption.textContent=value;}
function appendStream(delta){if(!state.streamingNode)state.streamingNode=addMessage('assistant','');state.streamingNode.textContent+=String(delta||'');setCaption(state.streamingNode.textContent);els.messages.scrollTop=els.messages.scrollHeight;}
function resetStream(){if(state.streamingNode){state.streamingNode.remove();state.streamingNode=null;}}
function finalizeStream(text,meta){if(state.streamingNode){state.streamingNode.textContent=String(text||state.streamingNode.textContent);addMeta(meta);state.streamingNode=null;}else addMessage('assistant',text,meta);setCaption(text);}

function renderCore(){
  const busy=['THINKING','ROUTING','GENERATING'].includes(state.status);
  els.voiceOrb.classList.toggle('listening',state.listening);
  els.voiceOrb.classList.toggle('speaking',state.playing||state.status==='SPEAKING');
  els.voiceOrb.classList.toggle('thinking',busy);
  els.voiceOrb.disabled=!state.micSupported||busy;
  if(state.listening){els.voiceEyebrow.textContent='LISTENING';els.voicePrompt.textContent='Go ahead.';return;}
  if(state.playing||state.status==='SPEAKING'){els.voiceEyebrow.textContent='ULTRON SPEAKING';els.voicePrompt.textContent='Tap the core to interrupt.';return;}
  if(busy){els.voiceEyebrow.textContent='PROCESSING';els.voicePrompt.textContent='I’m working on it.';return;}
  if(!state.micSupported){els.voiceEyebrow.textContent='MIC INPUT UNAVAILABLE';els.voicePrompt.textContent='Use the chat backup on this browser.';return;}
  els.voiceEyebrow.textContent='TAP THE CORE TO SPEAK';els.voicePrompt.textContent='I’m listening when you are.';
}
function setState(s){state.status=String(s||'IDLE').toUpperCase();els.statusText.textContent=`ONLINE // ${state.status}`;els.hudState.textContent=state.status;renderCore();}

function setChatOpen(open){state.chatOpen=Boolean(open);els.shell.classList.toggle('chat-open',state.chatOpen);els.chatToggle.classList.toggle('active',state.chatOpen);localStorage.setItem('ultron-m3-chat-open',state.chatOpen?'1':'0');if(state.chatOpen)setTimeout(()=>els.input.focus(),160);}
async function refreshState(){try{const r=await fetch(`${API}/api/state`);const d=await r.json();els.memory.textContent=d.memory?.total??0;els.commitments.textContent=d.commitments?.length??0;els.hudMemory.textContent=String(d.memory?.total??0);}catch{}}

function renderVoiceButton(){els.voiceToggle.textContent=state.voiceEnabled?'AUDIO ON':'AUDIO OFF';els.voiceToggle.classList.toggle('muted',!state.voiceEnabled);els.voiceToggle.setAttribute('aria-pressed',String(!state.voiceEnabled));els.voiceToggle.title=state.voiceEnabled?'Mute ULTRON voice':'Enable ULTRON voice';}
function stopLocalAudio(){state.audioQueue.length=0;if(state.currentAudio){try{state.currentAudio.pause();state.currentAudio.currentTime=0;}catch{}state.currentAudio=null;}state.playing=false;renderCore();}
async function refreshVoiceStatus(){try{const r=await fetch(`${API}/api/voice/status`);const d=await r.json();if(d.ok!==false&&typeof d.enabled==='boolean'){state.voiceEnabled=d.enabled;renderVoiceButton();if(!state.voiceEnabled)stopLocalAudio();}}catch{renderVoiceButton();}}
async function toggleVoice(){const next=!state.voiceEnabled;els.voiceToggle.disabled=true;if(!next)stopLocalAudio();try{const r=await fetch(`${API}/api/voice/enabled`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:next})});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Voice toggle failed.');state.voiceEnabled=Boolean(d.enabled);renderVoiceButton();if(!state.voiceEnabled&&state.status==='SPEAKING')setState('COMPLETE');}catch(error){state.voiceEnabled=!next;renderVoiceButton();setCaption(`Voice control error. ${error.message}`);}finally{els.voiceToggle.disabled=false;}}
function playVoice(event){if(!state.voiceEnabled||!event?.audioUrl)return;state.audioQueue.push(event.audioUrl);drainVoice();}
async function drainVoice(){if(!state.voiceEnabled||state.playing||!state.audioQueue.length)return;state.playing=true;setState('SPEAKING');const url=state.audioQueue.shift();const audio=new Audio(url);state.currentAudio=audio;audio.volume=.92;audio.onended=()=>{state.currentAudio=null;state.playing=false;if(state.voiceEnabled&&state.audioQueue.length)drainVoice();else setState('COMPLETE');};audio.onerror=()=>{state.currentAudio=null;state.playing=false;if(state.voiceEnabled&&state.audioQueue.length)drainVoice();else setState('ERROR');};try{await audio.play();}catch{audio.onerror?.();}}

function initRecognition(){
  if(!SpeechRecognition)return;
  const recognition=new SpeechRecognition();
  recognition.lang=navigator.language||'en-IN';recognition.interimResults=true;recognition.continuous=false;recognition.maxAlternatives=1;
  recognition.onstart=()=>{state.listening=true;state.pendingSpeech='';state.interimSpeech='';els.voiceInterim.textContent='';setState('LISTENING');};
  recognition.onresult=(event)=>{
    let interim='';let finalText='';
    for(let i=event.resultIndex;i<event.results.length;i+=1){const text=String(event.results[i][0]?.transcript||'').trim();if(event.results[i].isFinal)finalText+=`${text} `;else interim+=`${text} `;}
    if(finalText.trim())state.pendingSpeech=`${state.pendingSpeech} ${finalText}`.trim();
    state.interimSpeech=interim.trim();els.voiceInterim.textContent=state.interimSpeech||state.pendingSpeech;
  };
  recognition.onerror=(event)=>{state.listening=false;els.voiceInterim.textContent='';const code=String(event.error||'microphone error');if(code!=='no-speech'&&code!=='aborted')setCaption(`I couldn't hear you clearly. ${code.replaceAll('-',' ')}.`);setState('IDLE');};
  recognition.onend=()=>{const spoken=state.pendingSpeech.trim();state.listening=false;state.pendingSpeech='';state.interimSpeech='';els.voiceInterim.textContent='';if(spoken){setCaption(`You said: ${spoken}`);void submitMessage(spoken,'voice');}else if(state.status==='LISTENING')setState('IDLE');};
  state.recognition=recognition;
}
function startListening(){
  if(!state.micSupported||!state.recognition)return;
  if(['THINKING','ROUTING','GENERATING'].includes(state.status))return;
  if(state.playing||state.currentAudio)stopLocalAudio();
  try{state.recognition.start();}catch(error){setCaption(`Microphone isn't ready yet. ${error.message||''}`);}
}
function stopListening(){if(state.listening&&state.recognition){try{state.recognition.stop();}catch{}}}
function toggleListening(){if(state.listening)stopListening();else startListening();}

async function submitMessage(text,inputMode='chat'){
  const value=String(text||'').trim();if(!value)return;
  if(els.send.disabled){setCaption('I’m still finishing the current request.');return;}
  state.streamingNode=null;addMessage('user',value,inputMode==='voice'?'VOICE INPUT':'CHAT INPUT');setCaption(inputMode==='voice'?`You: ${value}`:value);setState('THINKING');els.task.textContent='ACTIVE';
  const started=performance.now();els.send.disabled=true;els.voiceOrb.disabled=true;const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),CHAT_TIMEOUT_MS);
  try{
    const history=state.messages.slice(-10);
    const r=await fetch(`${API}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:value,history,inputMode}),signal:controller.signal});
    const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'ULTRON request failed.');
    const out=String(d.response||d.text||'').trim();if(!out)throw new Error('ULTRON returned an empty response.');
    state.model=d.model||state.model;els.model.textContent=state.model;els.hudModel.textContent=state.model;
    const elapsed=Math.round(performance.now()-started);els.hudLatency.textContent=`${elapsed}ms`;finalizeStream(out,`${state.model} · ${elapsed}ms`);state.messages.push({role:'user',content:value},{role:'assistant',content:out});
  }catch(err){resetStream();const message=err?.name==='AbortError'?`That took longer than ${Math.round(CHAT_TIMEOUT_MS/1000)} seconds, so I cancelled it.`:err.message;addMessage('assistant',`I couldn't complete that request: ${message}`,'ERROR');setCaption(`I couldn't complete that. ${message}`);setState('ERROR');}
  finally{clearTimeout(timeout);els.send.disabled=false;els.task.textContent='READY';renderCore();await refreshState();}
}
function sendTyped(){const text=els.input.value.trim();if(!text)return;els.input.value='';void submitMessage(text,'chat');}

function connectEvents(){
  const es=new EventSource(`${API}/api/events`);
  const types=['task_started','context_ready','plan_created','model_selection','model_started','model_candidate_started','model_candidate_failed','model_candidate_succeeded','model_failed','model_delta','model_stream_fallback','model_stream_reset','model_backup_selected','model_league_started','model_league_trial_started','model_league_trial_completed','model_league_trial_failed','model_league_completed','model_league_promoted','model_league_error','tool_started','tool_completed','tool_failed','verification_complete','response_ready','task_completed','proactive_alert','model_catalog_unavailable','voice_started','voice_ready','voice_prefetch_next','voice_completed','voice_error','voice_state_changed'];
  types.forEach(type=>es.addEventListener(type,e=>{try{
    const ev=JSON.parse(e.data);
    if(type==='model_delta'){appendStream(ev.delta);if(ev.model){state.model=ev.model;els.model.textContent=state.model;els.hudModel.textContent=state.model;}setState('GENERATING');return;}
    if(type==='model_stream_reset'){resetStream();state.events.push(ev);renderEvents();setState('ROUTING');return;}
    if(type==='voice_state_changed'){state.voiceEnabled=Boolean(ev.enabled);if(!state.voiceEnabled)stopLocalAudio();renderVoiceButton();return;}
    const leagueEvent=type.startsWith('model_league_');const backgroundExact=Boolean(ev.exactRouting&&els.task.textContent==='READY');state.events.push(ev);if(state.events.length>120)state.events.shift();if(leagueEvent||backgroundExact){renderEvents();return;}
    if(type==='model_candidate_started'){state.model=ev.model||state.model;els.model.textContent=state.model;els.hudModel.textContent=state.model;setState('ROUTING');}
    else if(type==='model_candidate_failed')setState('ROUTING');
    else if(type==='model_candidate_succeeded'){state.model=ev.model||state.model;els.model.textContent=state.model;els.hudModel.textContent=state.model;setState('GENERATING');}
    else if(type==='model_backup_selected'){state.model=ev.nextModel||state.model;els.model.textContent=state.model;els.hudModel.textContent=state.model;setState('ROUTING');}
    else if(ev.model&&type!=='model_selection'&&type!=='model_started'){state.model=ev.model;els.model.textContent=ev.model;els.hudModel.textContent=ev.model;}
    if(ev.durationMs)els.hudLatency.textContent=`${Math.round(ev.durationMs)}ms`;
    if(type==='voice_ready')playVoice(ev);else if(type==='voice_started'&&state.voiceEnabled)setState('SPEAKING');else if(type==='task_completed'&&!state.playing)setState('COMPLETE');else if(type==='model_failed'||type==='tool_failed')setState('ERROR');else if(!['model_candidate_started','model_candidate_failed','model_candidate_succeeded','voice_started','model_backup_selected'].includes(type))setState((ev.state||type).toUpperCase());
    renderEvents();
  }catch{}}));
}

els.send.addEventListener('click',sendTyped);els.voiceToggle.addEventListener('click',toggleVoice);els.chatToggle.addEventListener('click',()=>setChatOpen(!state.chatOpen));els.chatClose.addEventListener('click',()=>setChatOpen(false));els.voiceOrb.addEventListener('click',toggleListening);
els.input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendTyped();}});
document.addEventListener('keydown',e=>{if(e.ctrlKey&&e.code==='Space'&&!e.repeat){const tag=String(e.target?.tagName||'').toLowerCase();if(!['textarea','input'].includes(tag)){e.preventDefault();toggleListening();}}});

const canvas=document.querySelector('#globe'),ctx=canvas.getContext('2d');let rot=0,last=performance.now();
const points=Array.from({length:132},(_,i)=>{const a=i*Math.PI*(3-Math.sqrt(5)),y=1-(i/131)*2,r=Math.sqrt(Math.max(0,1-y*y));return{x:r*Math.cos(a),y,z:r*Math.sin(a)};});
const satellites=Array.from({length:4},(_,i)=>({a:i*1.48,s:.0017+i*.00055,r:1.18+i*.075}));
function resize(){const rect=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,1.2);canvas.width=Math.floor(rect.width*dpr);canvas.height=Math.floor(rect.height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);}new ResizeObserver(resize).observe(canvas);resize();
function draw(now){const dt=Math.min(32,now-last);last=now;const w=canvas.clientWidth,h=canvas.clientHeight,cx=w/2,cy=h/2,r=Math.min(w,h)*.35;ctx.clearRect(0,0,w,h);rot+=dt*.00038;ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.strokeStyle='rgba(99,214,255,.10)';ctx.lineWidth=1;ctx.stroke();const projected=points.map(p=>{const x=p.x*Math.cos(rot)-p.z*Math.sin(rot),z=p.x*Math.sin(rot)+p.z*Math.cos(rot),scale=1/(1+z*.35);return{x:cx+x*r*scale,y:cy+p.y*r*scale,z,scale};});projected.sort((a,b)=>a.z-b.z);for(let i=0;i<projected.length;i++){const a=projected[i];if(a.z<-.55)continue;for(let j=i+1;j<projected.length;j++){const b=projected[j];if(b.z<-.3)continue;const d=Math.hypot(a.x-b.x,a.y-b.y);if(d<44){ctx.strokeStyle=`rgba(99,214,255,${Math.max(0,.08*(1-d/44))*a.scale})`;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}}}for(const p of projected){const alpha=.12+Math.max(0,p.z)*.48;ctx.fillStyle=`rgba(210,244,255,${alpha})`;ctx.beginPath();ctx.arc(p.x,p.y,1+p.scale*.55,0,Math.PI*2);ctx.fill();}satellites.forEach(s=>{s.a+=s.s*dt;const x=Math.cos(s.a)*r*s.r,y=Math.sin(s.a)*r*s.r*.48;ctx.fillStyle='rgba(99,214,255,.7)';ctx.beginPath();ctx.arc(cx+x,cy+y,1.7,0,Math.PI*2);ctx.fill();});requestAnimationFrame(draw);}requestAnimationFrame(draw);

initRecognition();connectEvents();refreshState();refreshVoiceStatus();setChatOpen(state.chatOpen);setInterval(refreshState,15000);setState('IDLE');addMessage('assistant','ULTRON Mark 3 online. Voice is primary; chat is standing by.','SYSTEM · READY');
