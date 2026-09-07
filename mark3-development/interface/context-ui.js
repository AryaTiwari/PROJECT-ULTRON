(() => {
  const state = { fabric: null, sessions: [], loadedHistory: false, dockOpen: localStorage.getItem('ultron-m3-context-open') !== '0' };

  const esc = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const clean = (value, max = 120) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
  };
  const time = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  function shell() { return document.querySelector('.m3-shell'); }
  function messages() { return document.querySelector('#messages'); }
  function input() { return document.querySelector('#input'); }
  function sendButton() { return document.querySelector('#send'); }

  function installDock() {
    const root = shell();
    if (!root || document.querySelector('#contextDock')) return;
    const workspace = root.querySelector('.workspace');
    const topActions = root.querySelector('.top-actions');
    const button = document.createElement('button');
    button.id = 'contextToggle';
    button.type = 'button';
    button.className = 'utility-button context-toggle';
    button.textContent = 'CONTEXT';
    button.addEventListener('click', () => setDockOpen(!state.dockOpen));
    topActions?.prepend(button);

    const dock = document.createElement('aside');
    dock.id = 'contextDock';
    dock.className = 'context-dock';
    dock.innerHTML = `
      <div class="context-head">
        <div><span class="panel-kicker">SHARED INTELLIGENCE</span><strong>CONTEXT FABRIC</strong></div>
        <div class="context-health"><span id="contextHealthDot"></span><b id="contextHealthScore">—</b></div>
      </div>
      <div class="context-clock"><span id="contextDaypart">SYNCING</span><b id="contextClock">—</b></div>
      <div class="context-grid">
        <button class="context-card context-card-action" id="previousThread" type="button">
          <span>PREVIOUS THREAD</span><b id="previousThreadTitle">No thread yet</b><small id="previousThreadMeta"></small>
        </button>
        <div class="context-card"><span>NEXT FOCUS</span><b id="nextFocus">No recorded priority</b><small id="nextFocusMeta"></small></div>
      </div>
      <div class="context-card wide diagnostic-card"><span>SYSTEM COACH</span><b id="systemCoach">Running local diagnostics…</b></div>
      <div class="context-section">
        <div class="context-section-head"><span>CAPABILITY MESH</span><small>READY + BUILDING</small></div>
        <div id="featureMesh" class="feature-mesh"></div>
      </div>
      <div class="context-section history-section">
        <div class="context-section-head"><span>RECENT THREADS</span><button id="restoreCurrentHistory" type="button">LATEST</button></div>
        <div id="sessionList" class="session-list"></div>
      </div>
      <div class="context-section quick-section">
        <div class="context-section-head"><span>QUICK MOVES</span><small>NO SIDE EFFECTS</small></div>
        <div class="quick-moves">
          <button data-command="Ultron, run a system audit and tell me the one thing we should check next.">DIAGNOSE</button>
          <button data-command="Ultron, resume the most relevant unfinished thread from our recent chats and give me the next concrete step.">RESUME</button>
          <button data-command="Ultron, suggest Reel ideas using my current Instagram aesthetic, current trend intelligence, and what you have learned from my feedback.">REEL IDEAS</button>
          <button data-command="Ultron, tell me what Forge can build next that would create the most leverage for my current projects.">FORGE NEXT</button>
        </div>
      </div>`;
    workspace?.appendChild(dock);

    dock.querySelectorAll('[data-command]').forEach((node) => node.addEventListener('click', () => runCommand(node.dataset.command)));
    dock.querySelector('#restoreCurrentHistory')?.addEventListener('click', () => loadHistory(true));
    dock.querySelector('#previousThread')?.addEventListener('click', () => {
      const id = state.fabric?.previousSession?.id || state.fabric?.recentSessions?.[0]?.id;
      if (id) loadSession(id);
    });
    setDockOpen(state.dockOpen);
  }

  function setDockOpen(open) {
    state.dockOpen = Boolean(open);
    shell()?.classList.toggle('context-open', state.dockOpen);
    document.querySelector('#contextToggle')?.classList.toggle('active', state.dockOpen);
    localStorage.setItem('ultron-m3-context-open', state.dockOpen ? '1' : '0');
  }

  function runCommand(command) {
    const field = input();
    if (!field || !command) return;
    field.value = command;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    const button = sendButton();
    if (button && !button.disabled) button.click();
  }

  function renderMessageRows(rows, { replace = false, historical = true } = {}) {
    const target = messages();
    if (!target || !Array.isArray(rows)) return;
    if (replace) target.innerHTML = '';
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      if (!row || !['user', 'assistant'].includes(row.role) || !String(row.content || '').trim()) continue;
      const node = document.createElement('div');
      node.className = `msg ${row.role}${historical ? ' history-message' : ''}`;
      node.textContent = row.content;
      fragment.appendChild(node);
      if (row.at) {
        const meta = document.createElement('div');
        meta.className = 'msg meta history-meta';
        meta.textContent = `${time(row.at)}${row.model ? ` · ${row.model}` : ''}`;
        fragment.appendChild(meta);
      }
    }
    target.appendChild(fragment);
    target.scrollTop = target.scrollHeight;
  }

  async function loadHistory(force = false) {
    if (state.loadedHistory && !force) return;
    try {
      const response = await fetch('/api/conversation/history?limit=120');
      const data = await response.json();
      if (!response.ok || !data.ok) return;
      renderMessageRows(data.messages || [], { replace: true, historical: true });
      state.loadedHistory = true;
    } catch {}
  }

  async function loadSession(id) {
    if (!id) return;
    try {
      const response = await fetch(`/api/conversation/session?id=${encodeURIComponent(id)}`);
      const data = await response.json();
      if (!response.ok || !data.ok) return;
      renderMessageRows(data.messages || [], { replace: true, historical: true });
      if (!shell()?.classList.contains('chat-open')) document.querySelector('#chatToggle')?.click();
      const caption = document.querySelector('#voiceCaption');
      if (caption) caption.textContent = 'Loaded an earlier conversation thread. New messages still continue in the live session.';
    } catch {}
  }

  function renderFabric(data) {
    state.fabric = data;
    const score = data.health?.score;
    const healthState = String(data.health?.state || 'unknown');
    const scoreNode = document.querySelector('#contextHealthScore');
    const dot = document.querySelector('#contextHealthDot');
    if (scoreNode) scoreNode.textContent = Number.isFinite(Number(score)) ? `${score}/100` : 'LOCAL';
    if (dot) dot.dataset.state = healthState;

    const daypart = document.querySelector('#contextDaypart');
    const clock = document.querySelector('#contextClock');
    if (daypart) daypart.textContent = `${String(data.clock?.daypart || 'online').replace('-', ' ').toUpperCase()} · ${data.clock?.weekday || ''}`;
    if (clock) clock.textContent = `${data.clock?.timeLabel || '—'} · ${data.clock?.dateLabel || ''}`;

    const previous = data.previousSession || data.recentSessions?.[0] || null;
    const previousTitle = document.querySelector('#previousThreadTitle');
    const previousMeta = document.querySelector('#previousThreadMeta');
    if (previousTitle) previousTitle.textContent = previous?.title || 'No previous thread yet';
    if (previousMeta) previousMeta.textContent = previous ? `${time(previous.endedAt)} · ${clean(previous.lastUser, 72)}` : 'Conversation continuity is ready.';

    const focus = data.topAction;
    const focusNode = document.querySelector('#nextFocus');
    const focusMeta = document.querySelector('#nextFocusMeta');
    if (focusNode) focusNode.textContent = focus?.title || 'No recorded priority';
    if (focusMeta) focusMeta.textContent = focus?.project || (data.yesterdayCompleted?.length ? `Yesterday: ${clean(data.yesterdayCompleted[0].objective, 72)}` : 'Workspace is clear.');

    const coach = document.querySelector('#systemCoach');
    if (coach) coach.textContent = data.diagnostic?.text || 'No urgent system issue detected.';

    const mesh = document.querySelector('#featureMesh');
    if (mesh) {
      mesh.innerHTML = (data.features || []).map((item) => {
        const stateName = item.ready ? 'ready' : item.implemented ? 'building' : 'planned';
        return `<span class="feature-chip ${stateName}" title="${esc(item.mode || '')}"><i></i>${esc(item.title)}</span>`;
      }).join('') || '<span class="feature-chip building"><i></i>Context loading</span>';
    }

    state.sessions = data.recentSessions || [];
    const sessionList = document.querySelector('#sessionList');
    if (sessionList) {
      sessionList.innerHTML = state.sessions.map((session) => `
        <button type="button" data-session="${esc(session.id)}">
          <b>${esc(clean(session.title, 58))}</b>
          <span>${esc(time(session.endedAt))} · ${Number(session.messageCount || 0)} msgs</span>
        </button>`).join('') || '<div class="empty-thread">No saved thread yet.</div>';
      sessionList.querySelectorAll('[data-session]').forEach((node) => node.addEventListener('click', () => loadSession(node.dataset.session)));
    }

    const caption = document.querySelector('#voiceCaption');
    if (caption && !/speaking|thinking|processing/i.test(document.querySelector('#statusText')?.textContent || '')) {
      const continuity = previous?.title ? `Context loaded. Previous thread: ${clean(previous.title, 70)}.` : 'Context Fabric online. Persistent history is ready.';
      caption.textContent = continuity;
    }
  }

  async function refreshFabric() {
    try {
      const response = await fetch('/api/context/fabric');
      const data = await response.json();
      if (response.ok && data.ok) renderFabric(data);
    } catch {}
  }

  function updateClockLocally() {
    if (!state.fabric?.clock?.timezone) return;
    const node = document.querySelector('#contextClock');
    if (!node) return;
    try {
      const now = new Date();
      const timeText = now.toLocaleTimeString([], { timeZone: state.fabric.clock.timezone, hour: '2-digit', minute: '2-digit' });
      node.textContent = `${timeText} · ${state.fabric.clock.dateLabel || ''}`;
    } catch {}
  }

  async function boot() {
    installDock();
    await Promise.all([loadHistory(false), refreshFabric()]);
    setInterval(refreshFabric, 60000);
    setInterval(updateClockLocally, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshFabric(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
