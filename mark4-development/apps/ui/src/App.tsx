import { useEffect, useMemo, useState } from "react";
import { api, liveEvents, streamChat } from "./api";
import type { ChatMessage, LiveEvent, Mission, SessionLike, ViewMode } from "./types";
import { CommandView } from "./components/CommandView";
import { MissionPanel } from "./components/MissionPanel";
import { BranchView } from "./components/BranchView";
import { OperationsView } from "./components/OperationsView";

const sessionId = (session: SessionLike) => String(session.id || session.session_id || "");

function listFrom(value: any): SessionLike[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.sessions)) return value.sessions;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(item => typeof item === "string" ? item : item?.text || item?.content || "").join("");
  return String(content?.text || content?.content || "");
}

function normalizeMessages(value: any): ChatMessage[] {
  const rows = Array.isArray(value) ? value
    : Array.isArray(value?.messages) ? value.messages
    : Array.isArray(value?.data) ? value.data
    : Array.isArray(value?.items) ? value.items
    : [];

  return rows.map((message: any, index: number) => ({
    id: String(message.id || message.message_id || index),
    role: (message.role || message.type?.split?.("/")[0] || "assistant") as ChatMessage["role"],
    content: textOf(message.content ?? message.message?.content ?? message.text)
  })).filter((message: ChatMessage) => Boolean(message.content) && ["user","assistant","system","tool"].includes(message.role));
}

function deltaOf(data: any) {
  return String(data?.delta ?? data?.text ?? data?.content ?? data?.output_text?.delta ?? data?.data?.delta ?? "");
}

function Icon({ name }: { name: ViewMode | "plus" }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (name === "command") return <svg {...common}><path d="M4 5.5h16v11H8l-4 3v-14Z"/><path d="M8 10h8M8 13h5"/></svg>;
  if (name === "mission") return <svg {...common}><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M22 12h-3M12 22v-3M2 12h3"/></svg>;
  if (name === "branches") return <svg {...common}><circle cx="6" cy="5" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="18" cy="17" r="2"/><path d="M8 5h2a4 4 0 0 1 4 4v4a4 4 0 0 0 4 4M14 10a4 4 0 0 0 4-3"/></svg>;
  if (name === "operations") return <svg {...common}><path d="M4 17V7l8-4 8 4v10l-8 4-8-4Z"/><path d="m4 7 8 5 8-5M12 12v9"/></svg>;
  return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>;
}

export function App() {
  const [view, setView] = useState<ViewMode>("command");
  const [sessions, setSessions] = useState<SessionLike[]>([]);
  const [active, setActive] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState("");
  const [health, setHealth] = useState(false);
  const [error, setError] = useState("");
  const [activeRunId, setActiveRunId] = useState("");
  const [pendingApproval, setPendingApproval] = useState<any | null>(null);
  const [sessionFilter, setSessionFilter] = useState("");

  const mission = missions[0] || null;
  const activeSession = useMemo(() => sessions.find(session => sessionId(session) === active), [sessions, active]);
  const visibleSessions = useMemo(() => {
    const q = sessionFilter.trim().toLowerCase();
    return sessions.filter(session => !q || String(session.title || "Untitled").toLowerCase().includes(q)).slice(0, 28);
  }, [sessions, sessionFilter]);

  async function refresh() {
    try {
      const data = await api.bootstrap();
      setHealth(Boolean(data.health?.ok));
      const sessionRows = listFrom(data.sessions);
      setSessions(sessionRows);
      setMissions(data.missions || []);

      let next = active || sessionId(sessionRows[0] || {});
      if (!next) {
        const created = await api.createSession("ULTRON");
        const createdSession = created.session || created;
        next = String(createdSession.id || createdSession.session_id || "");
        setSessions(listFrom(await api.sessions()));
      }
      if (next) {
        setActive(next);
        setMessages(normalizeMessages(await api.messages(next)));
      }
      setError("");
    } catch (cause: any) {
      setHealth(false);
      setError(cause.message || "ULTRON gateway is unavailable.");
    }
  }

  useEffect(() => {
    void refresh();
    const close = liveEvents((type, data) => {
      setEvents(previous => [...previous.slice(-119), { type, data, at: data?.at || new Date().toISOString() }]);
    });
    return close;
  }, []);

  useEffect(() => {
    if (!active) return;
    api.messages(active).then(value => setMessages(normalizeMessages(value))).catch(() => {});
  }, [active]);

  useEffect(() => {
    const latest = events.at(-1);
    if (latest && ["mission.updated","evidence.recorded","run.settled"].includes(latest.type)) {
      api.bootstrap().then(value => setMissions(value.missions || [])).catch(() => {});
    }
  }, [events.length]);

  async function send(text: string) {
    if (!active || busy) return;
    setBusy(true); setStreaming(""); setError(""); setActiveRunId(""); setPendingApproval(null);
    setMessages(previous => [...previous, { id: "local-" + Date.now(), role: "user", content: text }]);

    let collected = "";
    try {
      await streamChat(active, { input: text, missionId: mission?.id || null, role: "cognition" }, (type, data) => {
        if (type === "run.started") setActiveRunId(String(data?.run_id || data?.runId || ""));
        if (type === "approval.request") setPendingApproval(data);
        if (type === "assistant.delta") {
          const delta = deltaOf(data);
          if (delta) { collected += delta; setStreaming(collected); }
        }
        if (["run.completed","run.failed","run.cancelled","run.interrupted"].includes(type)) setPendingApproval(null);
        if (type === "run.completed" && !collected) {
          const finalText = String(data?.output || data?.response || "");
          if (finalText) { collected = finalText; setStreaming(finalText); }
        }
      });
      setStreaming("");
      setMessages(normalizeMessages(await api.messages(active)));
      const nextBootstrap = await api.bootstrap();
      setMissions(nextBootstrap.missions || []);
    } catch (cause: any) {
      setError(cause.message);
      if (collected) setMessages(previous => [...previous, { id: "partial-" + Date.now(), role: "assistant", content: collected }]);
      setStreaming("");
    } finally {
      setBusy(false); setActiveRunId(""); setPendingApproval(null);
    }
  }

  async function resolveApproval(choice: string) {
    if (!activeRunId || !pendingApproval) return;
    const requestId = String(pendingApproval.request_id || pendingApproval.requestId || "");
    if (!requestId) throw new Error("Approval request id is missing.");
    await api.approve(activeRunId, requestId, choice);
    setPendingApproval(null);
  }

  async function stopRun() {
    if (activeRunId) await api.stopRun(activeRunId);
  }

  async function branch(id: string, title: string, anchorMessageId?: string) {
    const created = await api.branch(id, title, anchorMessageId);
    const createdSession = created.session || created;
    const newId = String(createdSession.id || createdSession.session_id || "");
    setSessions(listFrom(await api.sessions()));
    if (newId) { setActive(newId); setView("command"); }
  }

  async function newSession() {
    const created = await api.createSession("New session");
    const createdSession = created.session || created;
    const id = String(createdSession.id || createdSession.session_id || "");
    setSessions(listFrom(await api.sessions()));
    if (id) { setActive(id); setView("command"); }
  }

  const labels: Record<ViewMode,string> = { command:"Command", mission:"Mission", branches:"Branches", operations:"Operations" };

  return (
    <div className="ultron-shell">
      <aside className="nav-rail">
        <button className="ultron-mark" onClick={() => setView("command")} aria-label="ULTRON home"><span>U</span></button>
        <div className="rail-nav">
          {(Object.keys(labels) as ViewMode[]).map(key => (
            <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)} title={labels[key]}>
              <Icon name={key}/><span>{labels[key]}</span>
            </button>
          ))}
        </div>
        <div className="rail-bottom">
          <button onClick={() => void newSession()} title="New session"><Icon name="plus"/><span>New</span></button>
          <div className={"system-light " + (health ? "online" : "offline")} title={health ? "Hermes online" : "Runtime offline"} />
        </div>
      </aside>

      <aside className="session-sidebar">
        <div className="session-sidebar-head">
          <div><span className="micro-label">WORKSPACE</span><h1>ULTRON</h1></div>
          <button className="compact-plus" onClick={() => void newSession()} title="New session"><Icon name="plus"/></button>
        </div>
        <div className="session-search"><span>⌕</span><input value={sessionFilter} onChange={e => setSessionFilter(e.target.value)} placeholder="Search sessions"/></div>
        <div className="session-caption">RECENT</div>
        <div className="session-list">
          {visibleSessions.map(session => (
            <button key={sessionId(session)} className={active === sessionId(session) ? "active" : ""} onClick={() => setActive(sessionId(session))}>
              <span className="session-title">{session.title || "Untitled"}</span>
              <span className="session-id">{sessionId(session).slice(0,8)}</span>
            </button>
          ))}
          {!visibleSessions.length && <div className="sidebar-empty">No matching sessions</div>}
        </div>
        <div className="session-footer">
          <div className={"health-pill " + (health ? "online" : "offline")}><span/>{health ? "SYSTEM ONLINE" : "SYSTEM OFFLINE"}</div>
          <small>Hermes · Mark 4</small>
        </div>
      </aside>

      <section className={"main-frame " + (view === "command" && mission ? "with-inspector" : "")}>
        <header className="workspace-header">
          <div>
            <span className="micro-label">{labels[view].toUpperCase()}</span>
            <h2>{view === "command" ? (activeSession?.title || "New session") : labels[view]}</h2>
          </div>
          <div className="header-actions">
            {busy && <span className="thinking-state"><i/>Working</span>}
            <span className="runtime-name">MARK 4</span>
          </div>
        </header>

        <main className="workspace">
          {view === "command" && (
            <CommandView messages={messages} events={events} streaming={streaming} busy={busy} mission={mission}
              onSend={send} onBranch={messageId => branch(active,"Follow-up branch",messageId)}
              runId={activeRunId} approval={pendingApproval} onApproval={resolveApproval} onStop={stopRun}/>
          )}
          {view === "mission" && <div className="mission-full"><MissionPanel mission={mission}/></div>}
          {view === "branches" && <BranchView sessions={sessions} activeId={active} onSelect={setActive} onFork={(id,title)=>branch(id,title)}/>}
          {view === "operations" && <OperationsView events={events} mission={mission}/>}
          {error && <div className="error-banner"><strong>Runtime error</strong><span>{error}</span><button onClick={() => void refresh()}>Retry</button></div>}
        </main>

        {view === "command" && mission && <MissionPanel mission={mission}/>}
      </section>
    </div>
  );
}
