import type { Mission } from "../types";

function numeric(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function MissionPanel({ mission }: { mission?: Mission | null }) {
  if (!mission) {
    return (
      <aside className="mission-panel">
        <div className="panel-label">MISSION</div>
        <div className="quiet-card">
          No persistent mission yet. ULTRON creates one when an objective needs durable state.
        </div>
      </aside>
    );
  }

  const state: any = mission.state || {};
  const completion: any = mission.completionCriteria || {};
  const current = numeric(state.current ?? state.masterCurrent ?? state.completed);
  const target = numeric(state.target ?? state.targetTotal ?? completion.target);
  const percent = current !== null && target && target > 0
    ? Math.max(0, Math.min(100, Math.round(current / target * 100)))
    : null;
  const evidence = mission.evidence?.length ?? 0;

  return (
    <aside className="mission-panel">
      <div className="panel-label">MISSION</div>
      <h3>{mission.objective}</h3>
      <div className="status-line">
        <span className={"status-dot " + mission.status} />
        {mission.status}
      </div>

      {percent !== null && (
        <>
          <div className="metric-row">
            <span>{current} / {target}</span>
            <span>{percent}%</span>
          </div>
          <div className="progress">
            <span style={{ width: percent + "%" }} />
          </div>
        </>
      )}

      <div className="mission-section">
        <span>NEXT</span>
        <p>{mission.nextAction || "ULTRON is deciding the next useful action."}</p>
      </div>

      <div className="mission-section">
        <span>STRATEGY</span>
        <p>{Object.keys(mission.strategy || {}).length ? JSON.stringify(mission.strategy) : "Dynamic"}</p>
      </div>

      <div className="mini-grid">
        <div><b>{evidence}</b><span>Evidence</span></div>
        <div><b>{Object.keys(mission.constraints || {}).length}</b><span>Constraints</span></div>
      </div>
    </aside>
  );
}
