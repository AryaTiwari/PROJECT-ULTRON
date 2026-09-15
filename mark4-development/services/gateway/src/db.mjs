import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dataRoot } from "./config.mjs";

fs.mkdirSync(dataRoot, { recursive: true });
const db = new DatabaseSync(path.join(dataRoot, "state.db"));
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}',
  constraints_json TEXT NOT NULL DEFAULT '{}',
  completion_json TEXT NOT NULL DEFAULT '{}',
  strategy_json TEXT NOT NULL DEFAULT '{}',
  next_action TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  ref TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(mission_id) REFERENCES missions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_metrics (
  route_id TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  latency_ms_total INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`);

const parse = (value, fallback = {}) => { try { return JSON.parse(value ?? ""); } catch { return fallback; } };
const now = () => new Date().toISOString();

function mapMission(row) {
  if (!row) return null;
  return {
    id: row.id, objective: row.objective, status: row.status,
    state: parse(row.state_json), constraints: parse(row.constraints_json),
    completionCriteria: parse(row.completion_json), strategy: parse(row.strategy_json),
    nextAction: row.next_action || null, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function createMission(input = {}) {
  const objective = String(input.objective || "").trim();
  if (!objective) throw new Error("MISSION_OBJECTIVE_REQUIRED");
  const id = input.id || `mission-${crypto.randomUUID()}`;
  const at = now();
  db.prepare(`INSERT INTO missions
    (id, objective, status, state_json, constraints_json, completion_json, strategy_json, next_action, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, objective, input.status || "active", JSON.stringify(input.state || {}),
      JSON.stringify(input.constraints || {}), JSON.stringify(input.completionCriteria || {}),
      JSON.stringify(input.strategy || {}), input.nextAction || null, at, at);
  addEvent({ missionId: id, type: "mission.created", payload: { objective } });
  return getMission(id);
}

export function getMission(id) {
  return mapMission(db.prepare("SELECT * FROM missions WHERE id=?").get(String(id)));
}
export function listMissions(limit = 30) {
  return db.prepare("SELECT * FROM missions ORDER BY updated_at DESC LIMIT ?")
    .all(Math.max(1, Math.min(100, Number(limit) || 30))).map(mapMission);
}
export function updateMission(id, patch = {}) {
  const current = getMission(id);
  if (!current) return null;
  const next = {
    ...current,
    status: patch.status ?? current.status,
    state: patch.state ? { ...current.state, ...patch.state } : current.state,
    constraints: patch.constraints ? { ...current.constraints, ...patch.constraints } : current.constraints,
    completionCriteria: patch.completionCriteria ? { ...current.completionCriteria, ...patch.completionCriteria } : current.completionCriteria,
    strategy: patch.strategy ? { ...current.strategy, ...patch.strategy } : current.strategy,
    nextAction: patch.nextAction === undefined ? current.nextAction : patch.nextAction,
    updatedAt: now(),
  };
  db.prepare(`UPDATE missions SET status=?, state_json=?, constraints_json=?, completion_json=?,
    strategy_json=?, next_action=?, updated_at=? WHERE id=?`)
    .run(next.status, JSON.stringify(next.state), JSON.stringify(next.constraints),
      JSON.stringify(next.completionCriteria), JSON.stringify(next.strategy),
      next.nextAction, next.updatedAt, id);
  addEvent({ missionId: id, type: "mission.updated", payload: patch });
  return getMission(id);
}
export function addEvidence({ missionId, kind = "fact", source = "tool", ref = null, payload = {}, verified = false }) {
  if (!getMission(missionId)) throw new Error("MISSION_NOT_FOUND");
  const row = { id:`evidence-${crypto.randomUUID()}`, missionId, kind, source, ref, payload, verified:Boolean(verified), createdAt:now() };
  db.prepare(`INSERT INTO evidence (id, mission_id, kind, source, ref, payload_json, verified, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, missionId, kind, source, ref, JSON.stringify(payload), row.verified ? 1 : 0, row.createdAt);
  addEvent({ missionId, type:"evidence.recorded", payload:{ id:row.id, kind, source, ref, verified:row.verified } });
  return row;
}
export function listEvidence(missionId, limit = 100) {
  return db.prepare("SELECT * FROM evidence WHERE mission_id=? ORDER BY created_at DESC LIMIT ?")
    .all(missionId, Math.max(1, Math.min(500, Number(limit) || 100)))
    .map(r => ({ id:r.id, missionId:r.mission_id, kind:r.kind, source:r.source, ref:r.ref,
      payload:parse(r.payload_json), verified:Boolean(r.verified), createdAt:r.created_at }));
}
export function addEvent({ missionId = null, type, payload = {} }) {
  const createdAt = now();
  const info = db.prepare("INSERT INTO events (mission_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)")
    .run(missionId, type, JSON.stringify(payload), createdAt);
  return { id:Number(info.lastInsertRowid), missionId, type, payload, createdAt };
}
export function listEvents({ missionId = null, after = 0, limit = 200 } = {}) {
  const capped = Math.max(1, Math.min(1000, Number(limit) || 200));
  const rows = missionId
    ? db.prepare("SELECT * FROM events WHERE mission_id=? AND id>? ORDER BY id ASC LIMIT ?").all(missionId, Number(after)||0, capped)
    : db.prepare("SELECT * FROM events WHERE id>? ORDER BY id ASC LIMIT ?").all(Number(after)||0, capped);
  return rows.map(r => ({ id:r.id, missionId:r.mission_id, type:r.type, payload:parse(r.payload_json), createdAt:r.created_at }));
}
export function recordModelMetric(routeId, { success, latencyMs = 0 }) {
  const at = now();
  db.prepare(`INSERT INTO model_metrics(route_id,calls,successes,failures,latency_ms_total,updated_at)
    VALUES(?,1,?,?,?,?)
    ON CONFLICT(route_id) DO UPDATE SET calls=calls+1, successes=successes+excluded.successes,
      failures=failures+excluded.failures, latency_ms_total=latency_ms_total+excluded.latency_ms_total,
      updated_at=excluded.updated_at`)
    .run(routeId, success ? 1 : 0, success ? 0 : 1, Math.max(0, Math.round(latencyMs)), at);
}
export function modelMetrics() {
  return db.prepare("SELECT * FROM model_metrics").all().map(r => ({
    routeId:r.route_id, calls:r.calls, successes:r.successes, failures:r.failures,
    averageLatencyMs:r.calls ? Math.round(r.latency_ms_total/r.calls) : null, updatedAt:r.updated_at
  }));
}
