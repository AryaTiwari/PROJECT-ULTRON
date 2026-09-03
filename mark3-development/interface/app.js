const API='';
const CHAT_TIMEOUT_MS=120000;
const COMMAND_SILENCE_MS=4000;
const WAKE_WORD='ultron';
const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition||null;
const AudioContextClass=window.AudioContext||window.webkitAudioContext||null;

const state={
  status:'IDLE',model:'AUTO ROUTER',events:[],messages:[],audioQueue:[],playing:false,currentAudio:null,
  voiceEnabled:true,streamingNode:null,chatOpen:localStorage.getItem('ultron-m3-chat-open')==='1',
  micSupported:Boolean(SpeechRecognition),recognition:null,recognitionActive:false,recognitionMode:'idle',recognitionRestartTimer:null,
  wakeEnabled:localStorage.getItem('ultron-m3-wake-enabled')!=='0',wakeArmed:false,intentionalRecognitionStop:false,
  listening:false,commandFinal:'',commandInterim:'',silenceTimer:null,
  audioContext:null,audioAnalyser:null,audioData:null,speechEnergy:0,
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
      <button id="wakeToggle" class="utility-button wake-toggle" type="button">WAKE ON</button>
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
        <div id="voiceEyebrow" class="voice-eyebrow">${state.micSupported?'WAKE WORD READY':'MIC INPUT UNAVAILABLE'}</div>
        <div id="voicePrompt" class="voice-prompt">${state.micSupported?'Say “Ultron” or tap the core.':'Use the chat backup on this browser.'}</div>
        <div id="voiceInterim" class="voice-interim"></div>
        <div id="voiceCaption" class="voice-caption">ULTRON is online.</div>
        <div class="voice-shortcut">${state.micSupported?'Wake word “Ultron” · 4 sec silence to send · Ctrl + Space':'Chat remains fully available'}</div>
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
    <div class="hint">WAKE → LISTEN → UNDERSTAND → ACT → RESPOND</div>
  </footer>
</div>`;

const els={
  shell:document.querySelector('.m3-shell'),statusText:document.querySelector('#statusText'),hudState:document.querySelector('#hudState'),
  hudModel:document.querySelector('#hudModel'),hudLatency:document.querySelector('#hudLatency'),hudMemory:document.querySelector('#hudMemory'),
  model:document.querySelector('#model'),task:document.querySelector('#task'),memory:document.querySelector('#memory'),commitments:document.querySelector('#commitments'),
  activityList:document.querySelector('#activityList'),messages:document.querySelector('#messages'),input:document.querySelector('#input'),send:document.querySelector('#send'),
  voiceToggle:document.querySelector('#voiceToggle'),wakeToggle:document.querySelector('#wakeToggle'),chatToggle:document.querySelector('#chatToggle'),chatClose:document.querySelector('#chatClose'),
  voiceOrb:document.querySelector('#voiceOrb'),globeWrap:document.querySelector('#globeWrap'),voiceEyebrow:document.querySelector('#voiceEyebrow'),voicePrompt:document.querySelector('#voicePrompt'),
  voiceInterim:document.querySelector('#voiceInterim'),voiceCaption:document.querySelector('#voiceCaption'),
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

function busy(){return ['THINKING','ROUTING','GENERATING'].includes(state.status);}
function renderWakeButton(){
  if(!state.micSupported){els.wakeToggle.textContent='WAKE N/A';els.wakeToggle.disabled=true;return;}
  els.wakeToggle.disabled=false;
  els.wakeToggle.textContent=state.wakeEnabled?(state.wakeArmed?'WAKE ARMED':'WAKE ON'):'WAKE OFF';
  els.wakeToggle.classList.toggle('active',state.wakeEnabled);
  els.wakeToggle.classList.toggle('armed',state.wakeArmed);
}
function renderCore(){
  const commandListening=state.recognitionMode==='command'&&state.listening;
  const wakeListening=state.recognitionMode==='wake'&&state.wakeArmed;
  els.voiceOrb.classList.toggle('listening',commandListening);
  els.voiceOrb.classList.toggle('wake-listening',wakeListening);
  els.voiceOrb.classList.toggle('speaking',state.playing||state.status==='SPEAKING');
  els.voiceOrb.classList.toggle('thinking',busy());
  els.globeWrap.classList.toggle('command-listening',commandListening);
  els.globeWrap.classList.toggle('wake-listening',wakeListening);
  els.globeWrap.classList.toggle('speaking',state.playing||state.status==='SPEAKING');
  els.voiceOrb.disabled=!state.micSupported||busy();
  renderWakeButton();
  if(commandListening){els.voiceEyebrow.textContent='COMMAND LISTENING';els.voicePrompt.textContent='Take your time. I’ll send after four seconds of silence.';return;}
  if(state.playing||state.status==='SPEAKING'){els.voiceEyebrow.textContent='ULTRON SPEAKING';els.voicePrompt.textContent='Tap the core if you want to interrupt.';return;}
  if(busy()){els.voiceEyebrow.textContent='PROCESSING';els.voicePrompt.textContent='I’m on it.';return;}
  if(!state.micSupported){els.voiceEyebrow.textContent='MIC INPUT UNAVAILABLE';els.voicePrompt.textContent='Use the chat backup on this browser.';return;}
  if(wakeListening){els.voiceEyebrow.textContent='WAKE WORD ARMED';els.voicePrompt.textContent='Say “Ultron” when you need me.';return;}
  els.voiceEyebrow.textContent=state.wakeEnabled?'WAKE WORD READY':'TAP THE CORE TO SPEAK';
  els.voicePrompt.textContent=state.wakeEnabled?'Say “Ultron” or tap the core.':'I’m listening when you tap the core.';
}
function setState(s){state.status=String(s||'IDLE').toUpperCase();els.statusText.textContent=`ONLINE // ${state.status}`;els.hudState.textContent=state.status;renderCore();}
function setChatOpen(open){state.chatOpen=Boolean(open);els.shell.classList.toggle('chat-open',state.chatOpen);els.chatToggle.classList.toggle('active',state.chatOpen);localStorage.setItem('ultron-m3-chat-open',state.chatOpen?'1':'0');if(state.chatOpen)setTimeout(()=>els.input.focus(),160);}
async function refreshState(){try{const r=await fetch(`${API}/api/state`);const d=await r.json();els.memory.textContent=d.memory?.total??0;els.commitments.textContent=d.commitments?.length??0;els.hudMemory.textContent=String(d.memory?.total??0);}catch{}}

function renderVoiceButton(){els.voiceToggle.textContent=state.voiceEnabled?'AUDIO ON':'AUDIO OFF';els.voiceToggle.classList.toggle('muted',!state.voiceEnabled);els.voiceToggle.setAttribute('aria-pressed',String(!state.voiceEnabled));els.voiceToggle.title=state.voiceEnabled?'Mute ULTRON voice':'Enable ULTRON voice';}
function clearRecognitionRestart(){if(state.recognitionRestartTimer){clearTimeout(state.recognitionRestartTimer);state.recognitionRestartTimer=null;}}
function clearSilenceTimer(){if(state.silenceTimer){clearTimeout(state.silenceTimer);state.silenceTimer=null;}}
function stopRecognition({intentional=true}={}){
  clearRecognitionRestart();
  if(intentional)state.intentionalRecognitionStop=true;
  if(state.recognition&&state.recognitionActive){try{state.recognition.stop();}catch{}}
}
function stopLocalAudio(){
  state.audioQueue.length=0;
  if(state.currentAudio){try{state.currentAudio.pause();state.currentAudio.currentTime=0;}catch{}state.currentAudio=null;}
  state.playing=false;state.speechEnergy=0;els.globeWrap.style.setProperty('--orb-scale','1');els.globeWrap.style.setProperty('--speech-glow','28px');renderCore();
}
async function refreshVoiceStatus(){try{const r=await fetch(`${API}/api/voice/status`);const d=await r.json();if(d.ok!==false&&typeof d.enabled==='boolean'){state.voiceEnabled=d.enabled;renderVoiceButton();if(!state.voiceEnabled)stopLocalAudio();}}catch{renderVoiceButton();}}
async function toggleVoice(){const next=!state.voiceEnabled;els.voiceToggle.disabled=true;if(!next)stopLocalAudio();try{const r=await fetch(`${API}/api/voice/enabled`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:next})});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Voice toggle failed.');state.voiceEnabled=Boolean(d.enabled);renderVoiceButton();if(!state.voiceEnabled&&state.status==='SPEAKING')setState('COMPLETE');if(!state.voiceEnabled)armWakeSoon(350);}catch(error){state.voiceEnabled=!next;renderVoiceButton();setCaption(`Voice control error. ${error.message}`);}finally{els.voiceToggle.disabled=false;}}

function ensureAudioGraph(audio){
  if(!AudioContextClass)return;
  try{
    if(!state.audioContext)state.audioContext=new AudioContextClass();
    if(state.audioContext.state==='suspended')void state.audioContext.resume();
    const analyser=state.audioContext.createAnalyser();analyser.fftSize=256;analyser.smoothingTimeConstant=.58;
    const source=state.audioContext.createMediaElementSource(audio);source.connect(analyser);analyser.connect(state.audioContext.destination);
    state.audioAnalyser=analyser;state.audioData=new Uint8Array(analyser.fftSize);
  }catch{state.audioAnalyser=null;state.audioData=null;}
}
function playVoice(event){if(!state.voiceEnabled||!event?.audioUrl)return;state.audioQueue.push(event.audioUrl);drainVoice();}
async function drainVoice(){
  if(!state.voiceEnabled||state.playing||!state.audioQueue.length)return;
  stopRecognition({intentional:true});state.wakeArmed=false;
  state.playing=true;setState('SPEAKING');
  const url=state.audioQueue.shift();const audio=new Audio(url);state.currentAudio=audio;audio.volume=.92;ensureAudioGraph(audio);
  audio.onended=()=>{state.currentAudio=null;state.playing=false;state.audioAnalyser=null;state.audioData=null;if(state.voiceEnabled&&state.audioQueue.length)drainVoice();else{setState('COMPLETE');armWakeSoon(600);}};
  audio.onerror=()=>{state.currentAudio=null;state.playing=false;state.audioAnalyser=null;state.audioData=null;if(state.voiceEnabled&&state.audioQueue.length)drainVoice();else{setState('ERROR');armWakeSoon(700);}};
  try{await audio.play();}catch{audio.onerror?.();}
}

function normalizeCommandText(text){return String(text||'').replace(/\s+/g,' ').replace(/^[,.:;!?\-\s]+/,'').trim();}
function commandText(){return normalizeCommandText(`${state.commandFinal} ${state.commandInterim}`);}
function resetCommandBuffer(){state.commandFinal='';state.commandInterim='';els.voiceInterim.textContent='';clearSilenceTimer();}
function scheduleCommandSilence(){
  clearSilenceTimer();
  if(!commandText())return;
  state.silenceTimer=setTimeout(()=>finishCommand(),COMMAND_SILENCE_MS);
}
function wakeMatch(text){const value=String(text||'');const match=/\bultron\b/i.exec(value);return match?{match,index:match.index,after:normalizeCommandText(value.slice(match.index+match[0].length))}:null;}
function enterCommandMode(seed='',source='manual'){
  if(!state.micSupported||!state.recognition)return;
  if(state.playing||state.currentAudio)stopLocalAudio();
  state.recognitionMode='command';state.wakeArmed=false;state.listening=true;resetCommandBuffer();state.commandFinal=normalizeCommandText(seed);
  els.voiceInterim.textContent=state.commandFinal;setCaption(source==='wake'?'Yes. I’m listening.':'I’m listening.');setState('LISTENING');
  if(state.commandFinal)scheduleCommandSilence();
  if(!state.recognitionActive)startRecognition();
}
function finishCommand(){
  const spoken=commandText();clearSilenceTimer();state.listening=false;state.recognitionMode='idle';state.wakeArmed=false;resetCommandBuffer();stopRecognition({intentional:true});
  if(spoken){setCaption(`You: ${spoken}`);void submitMessage(spoken,'voice');}
  else{setState('IDLE');armWakeSoon(350);}
}
function cancelCommand(){clearSilenceTimer();resetCommandBuffer();state.listening=false;state.recognitionMode='idle';stopRecognition({intentional:true});setState('IDLE');armWakeSoon(300);}
function startRecognition(){
  if(!state.recognition||state.recognitionActive||state.playing||busy())return;
  state.intentionalRecognitionStop=false;
  try{state.recognition.start();}catch(error){if(!/already started/i.test(String(error.message||'')))setCaption(`Microphone isn't ready yet. ${error.message||''}`);}
}
function scheduleRecognitionRestart(){
  clearRecognitionRestart();
  if(!state.recognition||state.playing||busy())return;
  if(state.recognitionMode!=='wake'&&state.recognitionMode!=='command')return;
  state.recognitionRestartTimer=setTimeout(()=>startRecognition(),280);
}
function armWake(){
  if(!state.micSupported||!state.recognition||!state.wakeEnabled||state.playing||busy()||state.listening)return;
  state.recognitionMode='wake';state.wakeArmed=true;state.intentionalRecognitionStop=false;setState('IDLE');startRecognition();renderCore();
}
function armWakeSoon(delay=450){setTimeout(()=>armWake(),delay);}
function toggleWake(){
  if(!state.micSupported)return;
  state.wakeEnabled=!state.wakeEnabled;localStorage.setItem('ultron-m3-wake-enabled',state.wakeEnabled?'1':'0');
  if(!state.wakeEnabled){state.wakeArmed=false;if(state.recognitionMode==='wake'){state.recognitionMode='idle';stopRecognition({intentional:true});}setCaption('Wake word is off. Tap the core when you need me.');}
  else{setCaption('Wake word is on. Say “Ultron” when you need me.');armWakeSoon(80);}
  renderCore();
}

function initRecognition(){
  if(!SpeechRecognition)return;
  const recognition=new SpeechRecognition();
  recognition.lang=navigator.language||'en-IN';recognition.interimResults=true;recognition.continuous=true;recognition.maxAlternatives=1;
  recognition.onstart=()=>{state.recognitionActive=true;state.intentionalRecognitionStop=false;renderCore();};
  recognition.onresult=(event)=>{
    if(state.recognitionMode==='wake'){
      for(let i=event.resultIndex;i<event.results.length;i+=1){
        const text=String(event.results[i][0]?.transcript||'').trim();if(!text)continue;
        const hit=wakeMatch(text);
        if(hit){enterCommandMode(hit.after,'wake');return;}
      }
      return;
    }
    if(state.recognitionMode!=='command')return;
    let interim='';let heard=false;
    for(let i=event.resultIndex;i<event.results.length;i+=1){
      const text=String(event.results[i][0]?.transcript||'').trim();if(!text)continue;heard=true;
      if(event.results[i].isFinal){state.commandFinal=normalizeCommandText(`${state.commandFinal} ${text}`);}else interim+=`${text} `;
    }
    state.commandInterim=normalizeCommandText(interim);els.voiceInterim.textContent=commandText();if(heard)scheduleCommandSilence();renderCore();
  };
  recognition.onerror=(event)=>{
    const code=String(event.error||'microphone error');
    if(code==='not-allowed'||code==='service-not-allowed'){
      state.wakeArmed=false;state.recognitionMode='idle';state.listening=false;setCaption('Microphone permission is blocked. Allow microphone access in Chrome, then turn wake mode on again.');setState('IDLE');return;
    }
    if(code!=='no-speech'&&code!=='aborted')setCaption(`I couldn't hear clearly. ${code.replaceAll('-',' ')}.`);
  };
  recognition.onend=()=>{
    state.recognitionActive=false;
    const intentional=state.intentionalRecognitionStop;state.intentionalRecognitionStop=false;
    if(intentional)return;
    if(state.recognitionMode==='command'||(state.recognitionMode==='wake'&&state.wakeEnabled))scheduleRecognitionRestart();
  };
  state.recognition=recognition;
}
function toggleListening(){
  if(!state.micSupported||!state.recognition)return;
  if(state.recognitionMode==='command'&&state.listening){if(commandText())finishCommand();else cancelCommand();return;}
  enterCommandMode('','manual');
}

async function submitMessage(text,inputMode='chat'){
  const value=String(text||'').trim();if(!value)return;
  if(els.send.disabled){setCaption('I’m still finishing the current command.');return;}
  stopRecognition({intentional:true});state.wakeArmed=false;state.recognitionMode='idle';state.listening=false;
  state.streamingNode=null;addMessage('user',value,inputMode==='voice'?'VOICE INPUT':'CHAT INPUT');setCaption(inputMode==='voice'?`You: ${value}`:value);setState('THINKING');els.task.textContent='ACTIVE';
  const started=performance.now();els.send.disabled=true;els.voiceOrb.disabled=true;const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),CHAT_TIMEOUT_MS);
  try{
    const history=state.messages.slice(-10);
    const r=await fetch(`${API}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:value,history,inputMode}),signal:controller.signal});
    const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'ULTRON request failed.');
    const out=String(d.response||d.text||'').trim();if(!out)throw new Error('ULTRON returned an empty response.');
    state.model=d.model||state.model;els.model.textContent=state.model;els.hudModel.textContent=state.model;
    const elapsed=Math.round(performance.now()-started);els.hudLatency.textContent=`${elapsed}ms`;finalizeStream(out,`${state.model} · ${elapsed}ms`);state.messages.push({role:'user',content:value},{role:'assistant',content:out});
  }catch(err){resetStream();const message=err?.name==='AbortError'?`That took longer than ${Math.round(CHAT_TIMEOUT_MS/1000)} seconds, so I cancelled it.`:err.message;addMessage('assistant',`I couldn't complete that request: ${message}`,'ERROR');setCaption(`I couldn't complete that. ${message}`);setState('ERROR');armWakeSoon(700);}
  finally{clearTimeout(timeout);els.send.disabled=false;els.task.textContent='READY';renderCore();await refreshState();if(!state.voiceEnabled)armWakeSoon(500);}
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
    if(type==='voice_ready')playVoice(ev);
    else if(type==='voice_started'&&state.voiceEnabled){stopRecognition({intentional:true});state.wakeArmed=false;setState('SPEAKING');}
    else if(type==='voice_completed'&&!state.playing)armWakeSoon(550);
    else if(type==='voice_error')armWakeSoon(650);
    else if(type==='task_completed'&&!state.playing){setState('COMPLETE');if(!state.voiceEnabled)armWakeSoon(450);}
    else if(type==='model_failed'||type==='tool_failed')setState('ERROR');
    else if(!['model_candidate_started','model_candidate_failed','model_candidate_succeeded','voice_started','model_backup_selected'].includes(type))setState((ev.state||type).toUpperCase());
    renderEvents();
  }catch{}}));
}

els.send.addEventListener('click',sendTyped);els.voiceToggle.addEventListener('click',toggleVoice);els.wakeToggle.addEventListener('click',toggleWake);els.chatToggle.addEventListener('click',()=>setChatOpen(!state.chatOpen));els.chatClose.addEventListener('click',()=>setChatOpen(false));els.voiceOrb.addEventListener('click',toggleListening);
els.input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendTyped();}});
document.addEventListener('keydown',e=>{if(e.ctrlKey&&e.code==='Space'&&!e.repeat){const tag=String(e.target?.tagName||'').toLowerCase();if(!['textarea','input'].includes(tag)){e.preventDefault();toggleListening();}}});

document.addEventListener('pointerdown',()=>{if(state.wakeEnabled&&!state.wakeArmed&&state.recognitionMode!=='command'&&!busy()&&!state.playing)armWake();},{once:true});

const canvas=document.querySelector('#globe'),ctx=canvas.getContext('2d');let rot=0,last=performance.now();
const points=Array.from({length:142},(_,i)=>{const a=i*Math.PI*(3-Math.sqrt(5)),y=1-(i/141)*2,r=Math.sqrt(Math.max(0,1-y*y));return{x:r*Math.cos(a),y,z:r*Math.sin(a)};});
const satellites=Array.from({length:5},(_,i)=>({a:i*1.36,s:.0017+i*.00052,r:1.17+i*.072}));
function resize(){const rect=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,1.2);canvas.width=Math.floor(rect.width*dpr);canvas.height=Math.floor(rect.height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);}new ResizeObserver(resize).observe(canvas);resize();
function sampleSpeechEnergy(){
  let target=0;
  if(state.playing&&state.audioAnalyser&&state.audioData){
    state.audioAnalyser.getByteTimeDomainData(state.audioData);let sum=0;
    for(let i=0;i<state.audioData.length;i+=1){const v=(state.audioData[i]-128)/128;sum+=v*v;}
    const rms=Math.sqrt(sum/state.audioData.length);target=Math.min(1,Math.max(0,(rms-.015)*6.8));
  }
  state.speechEnergy=state.speechEnergy*.68+target*.32;
  if(!state.playing)state.speechEnergy*=.8;
  const scale=(1+state.speechEnergy*.16).toFixed(3);const glow=`${Math.round(28+state.speechEnergy*68)}px`;
  els.globeWrap.style.setProperty('--orb-scale',scale);els.globeWrap.style.setProperty('--speech-glow',glow);
  return state.speechEnergy;
}
function draw(now){
  const dt=Math.min(32,now-last);last=now;const energy=sampleSpeechEnergy();
  const command=state.recognitionMode==='command'&&state.listening?1:0;const wake=state.recognitionMode==='wake'&&state.wakeArmed?.2:0;
  const intensity=Math.max(command,wake,energy*1.15);const w=canvas.clientWidth,h=canvas.clientHeight,cx=w/2,cy=h/2,baseR=Math.min(w,h)*.35,r=baseR*(1+energy*.035);
  ctx.clearRect(0,0,w,h);rot+=dt*(.00038+command*.00072+wake*.00008+energy*.00092);
  ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.strokeStyle=`rgba(99,214,255,${.10+intensity*.13})`;ctx.lineWidth=1+intensity*.45;ctx.stroke();
  const projected=points.map(p=>{const x=p.x*Math.cos(rot)-p.z*Math.sin(rot),z=p.x*Math.sin(rot)+p.z*Math.cos(rot),scale=1/(1+z*.35);return{x:cx+x*r*scale,y:cy+p.y*r*scale,z,scale};});projected.sort((a,b)=>a.z-b.z);
  const linkDistance=44+command*9+energy*7;
  for(let i=0;i<projected.length;i+=1){const a=projected[i];if(a.z<-.55)continue;for(let j=i+1;j<projected.length;j+=1){const b=projected[j];if(b.z<-.3)continue;const d=Math.hypot(a.x-b.x,a.y-b.y);if(d<linkDistance){const alpha=Math.max(0,(.075+intensity*.08)*(1-d/linkDistance))*a.scale;ctx.strokeStyle=`rgba(99,214,255,${alpha})`;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}}}
  for(const p of projected){const alpha=.12+Math.max(0,p.z)*.48+intensity*.16;ctx.fillStyle=`rgba(210,244,255,${Math.min(.95,alpha)})`;ctx.beginPath();ctx.arc(p.x,p.y,1+p.scale*.55+intensity*.42,0,Math.PI*2);ctx.fill();}
  satellites.forEach(s=>{s.a+=s.s*dt*(1+command*1.8+energy*2.6);const x=Math.cos(s.a)*r*s.r,y=Math.sin(s.a)*r*s.r*.48;ctx.fillStyle=`rgba(99,214,255,${.62+intensity*.28})`;ctx.beginPath();ctx.arc(cx+x,cy+y,1.7+intensity*.5,0,Math.PI*2);ctx.fill();});requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

initRecognition();connectEvents();refreshState();refreshVoiceStatus();setChatOpen(state.chatOpen);renderWakeButton();setInterval(refreshState,15000);setState('IDLE');addMessage('assistant','ULTRON Mark 3 online. Say “Ultron” when you need me; chat is standing by.','SYSTEM · READY');setTimeout(()=>{if(state.wakeEnabled)armWake();},900);
