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
  if (Array.isArray(content)) {
    return content.map(item =>
      typeof item === "string" ? item : item?.text || item?.content || ""
    ).join("");
  }
  return String(content?.text || content?.content || "");
}

function normalizeMessages(value: any): ChatMessage[] {
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(value?.messages)
      ? value.messages
      : Array.isArray(value?.data)
        ? value.data
        : Array.isArray(value?.items)
          ? value.items
          : [];

  return rows
    .map((message: any, index: number) => ({
      id: String(message.id || message.message_id || index),
      role: (message.role || message.type?.split?.("/")[0] || "assistant") as ChatMessage["role"],
      content: textOf(message.content ?? message.message?.content ?? message.text)
    }))
    .filter((message: ChatMessage) =>
      Boolean(message.content) &&
      ["user", "assistant", "system", "tool"].includes(message.role)
    );
}

function deltaOf(data: any) {
  return String(
    data?.delta ??
    data?.text ??
    data?.content ??
    data?.output_text?.delta ??
    data?.data?.delta ??
    ""
  );
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

  const mission = missions[0] || null;

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
      setError(cause.message);
    }
  }

  useEffect(() => {
    void refresh();
    const close = liveEvents((type, data) => {
      setEvents(previous => [
        ...previous.slice(-119),
        { type, data, at: data?.at || new Date().toISOString() }
      ]);
    });
    return close;
  }, []);

  useEffect(() => {
    if (!active) return;
    api.messages(active).then(value => setMessages(normalizeMessages(value))).catch(() => {});
  }, [active]);

  useEffect(() => {
    if (!events.length) return;
    const latest = events.at(-1);
    if (
      latest?.type === "mission.updated" ||
      latest?.type === "evidence.recorded" ||
      latest?.type === "run.settled"
    ) {
      api.bootstrap().then(value => setMissions(value.missions || [])).catch(() => {});
    }
  }, [events.length]);

  async function send(text: string) {
    if (!active || busy) return;

    setBusy(true);
    setStreaming("");
    setError("");
    setActiveRunId("");
    setPendingApproval(null);

    setMessages(previous => [
      ...previous,
      { id: "local-" + Date.now(), role: "user", content: text }
    ]);

    let collected = "";

    try {
      await streamChat(
        active,
        { input: text, missionId: mission?.id || null, role: "cognition" },
        (type, data) => {
          if (type === "run.started") {
            setActiveRunId(String(data?.run_id || data?.runId || ""));
          }

          if (type === "approval.request") {
            setPendingApproval(data);
          }

          if (type === "assistant.delta") {
            const delta = deltaOf(data);
            if (delta) {
              collected += delta;
              setStreaming(collected);
            }
          }

          if (["run.completed","run.failed","run.cancelled","run.interrupted"].includes(type)) {
            setPendingApproval(null);
          }

          if (type === "run.completed" && !collected) {
            const finalText = String(data?.output || data?.response || "");
            if (finalText) {
              collected = finalText;
              setStreaming(finalText);
            }
          }

        }
      );

      setStreaming("");
      setMessages(normalizeMessages(await api.messages(active)));
      const nextBootstrap = await api.bootstrap();
      setMissions(nextBootstrap.missions || []);
    } catch (cause: any) {
      setError(cause.message);
      if (collected) {
        setMessages(previous => [
          ...previous,
          { id: "partial-" + Date.now(), role: "assistant", content: collected }
        ]);
      }
      setStreaming("");
    } finally {
      setBusy(false);
      setActiveRunId("");
      setPendingApproval(null);
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
    if (!activeRunId) return;
    await api.stopRun(activeRunId);
  }

  async function branch(id: string, title: string, anchorMessageId?: string) {
    const created = await api.branch(id, title, anchorMessageId);
    const createdSession = created.session || created;
    const newId = String(createdSession.id || createdSession.session_id || "");
    setSessions(listFrom(await api.sessions()));
    if (newId) {
      setActive(newId);
      setView("command");
    }
  }

  const labels: Record<ViewMode, string> = {
    command: "Command",
    mission: "Mission",
    branches: "Branches",
    operations: "Operations"
  };

  const activeSession = useMemo(
    () => sessions.find(session => sessionId(session) === active),
    [sessions, active]
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-glyph">U</span>
          <div><b>ULTRON</b><small>MARK 4</small></div>
        </div>

        <nav>
          {(Object.keys(labels) as ViewMode[]).map(key => (
            <button
              key={key}
              className={view === key ? "active" : ""}
              onClick={() => setView(key)}
            >
              {labels[key]}
            </button>
          ))}
        </nav>

        <div className="runtime-state">
          <span className={"runtime-dot " + (health ? "online" : "offline")} />
          {health ? "ONLINE" : "OFFLINE"}
        </div>
      </header>

      <div className="body-grid">
        <aside className="sidebar">
          <div className="panel-label">SESSIONS</div>
          <div className="session-list">
            {sessions.slice(0, 18).map(session => (
              <button
                key={sessionId(session)}
                className={active === sessionId(session) ? "active" : ""}
                onClick={() => setActive(sessionId(session))}
              >
                <span>{session.title || "Untitled"}</span>
                <small>{sessionId(session).slice(0, 10)}</small>
              </button>
            ))}
          </div>

          <button
            className="new-session"
            onClick={async () => {
              const created = await api.createSession("New session");
              const createdSession = created.session || created;
              const id = String(createdSession.id || createdSession.session_id || "");
              setSessions(listFrom(await api.sessions()));
              if (id) setActive(id);
            }}
          >
            + New session
          </button>

          <div className="sidebar-foot">
            <span>{activeSession?.title || "No session"}</span>
            <small>Hermes-backed</small>
          </div>
        </aside>

        <main className="workspace">
          {view === "command" && (
            <CommandView
              messages={messages}
              events={events}
              streaming={streaming}
              busy={busy}
              mission={mission}
              onSend={send}
              onBranch={messageId => branch(active, "Follow-up branch", messageId)}
              runId={activeRunId}
              approval={pendingApproval}
              onApproval={resolveApproval}
              onStop={stopRun}
            />
          )}

          {view === "mission" && (
            <div className="mission-full">
              <div className="view-heading">
                <div>
                  <span className="eyebrow">OBJECTIVE STATE</span>
                  <h2>Mission Control</h2>
                </div>
              </div>
              <MissionPanel mission={mission} />
            </div>
          )}

          {view === "branches" && (
            <BranchView
              sessions={sessions}
              activeId={active}
              onSelect={setActive}
              onFork={(id, title) => branch(id, title)}
            />
          )}

          {view === "operations" && (
            <OperationsView events={events} mission={mission} />
          )}

          {error && <div className="error-banner">{error}</div>}
        </main>

        {view === "command" && <MissionPanel mission={mission} />}
      </div>
    </div>
  );
}
