import { useMemo, useState } from "react";
import type { SessionLike } from "../types";

const idOf = (session: SessionLike) => String(session.id || session.session_id || "");
const parentOf = (session: SessionLike) => String(
  session.parent_session_id ||
  session.parent_id ||
  (session as any).parent_session?.id ||
  ""
);

export function BranchView({
  sessions,
  activeId,
  onSelect,
  onFork
}: {
  sessions: SessionLike[];
  activeId: string;
  onSelect: (id: string) => void;
  onFork: (id: string, title: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const rows = useMemo(
    () => sessions
      .map(session => ({ ...session, _id: idOf(session), _parent: parentOf(session) }))
      .filter(session => session._id),
    [sessions]
  );

  const roots = rows.filter(session =>
    !session._parent || !rows.some(other => other._id === session._parent)
  );

  const children = (id: string) => rows.filter(session => session._parent === id);

  async function fork(id: string) {
    setBusy(true);
    try {
      await onFork(id, "Exploration branch");
    } finally {
      setBusy(false);
    }
  }

  function Node({ session, depth = 0 }: { session: any; depth?: number }) {
    const kids = children(session._id);
    return (
      <div className="branch-group">
        <button
          className={"branch-card " + (activeId === session._id ? "active" : "")}
          onClick={() => onSelect(session._id)}
          style={{ marginLeft: depth * 28 }}
        >
          <span className="branch-knot" />
          <span>
            <b>{session.title || "Untitled session"}</b>
            <small>{session._id.slice(0, 12)}</small>
          </span>
        </button>
        {kids.map(child => (
          <Node key={child._id} session={child} depth={depth + 1} />
        ))}
      </div>
    );
  }

  return (
    <section className="branches-view">
      <div className="view-heading">
        <div>
          <span className="eyebrow">CONVERSATION MAP</span>
          <h2>Branches</h2>
        </div>
        <button
          disabled={!activeId || busy}
          className="secondary-button"
          onClick={() => void fork(activeId)}
        >
          + Fork selected
        </button>
      </div>

      <p className="view-note">
        Branches are real Hermes child sessions. Side exploration stays isolated until you intentionally act on it.
      </p>

      <div className="branch-canvas">
        {roots.map(root => <Node key={root._id} session={root} />)}
      </div>
    </section>
  );
}
