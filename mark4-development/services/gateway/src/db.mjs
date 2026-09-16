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
CREATE TABLE IF NOT EXISTS model_route_state (
  route_id TEXT PRIMARY KEY,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  cooldown_until TEXT,
  last_error_class TEXT,
  last_error TEXT,
  last_success_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lead_master (
  id TEXT PRIMARY KEY,
  company_key TEXT NOT NULL UNIQUE,
  company_name TEXT NOT NULL,
  company_link TEXT,
  job_link TEXT,
  job_title TEXT,
  location TEXT,
  employee_count INTEGER,
  applicant_count INTEGER,
  source TEXT NOT NULL DEFAULT 'linkedin',
  verification_status TEXT NOT NULL DEFAULT 'pending',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  contact_name TEXT,
  contact_role TEXT,
  contact_linkedin TEXT,
  contact_company TEXT,
  phone TEXT,
  email TEXT,
  secondary_contact_name TEXT,
  secondary_contact_role TEXT,
  secondary_contact_linkedin TEXT,
  secondary_phone TEXT,
  secondary_email TEXT,
  tertiary_contact_name TEXT,
  tertiary_contact_role TEXT,
  tertiary_contact_linkedin TEXT,
  tertiary_phone TEXT,
  tertiary_email TEXT,
  remarks TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_master_status ON lead_master(verification_status);
CREATE INDEX IF NOT EXISTS idx_lead_master_location ON lead_master(location);
CREATE TABLE IF NOT EXISTS creator_registry (
  id TEXT PRIMARY KEY,
  creator_key TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  handle TEXT NOT NULL,
  profile_url TEXT,
  display_name TEXT,
  niche TEXT,
  location TEXT,
  follower_count INTEGER,
  avg_views INTEGER,
  fit_score INTEGER,
  qualification_status TEXT NOT NULL DEFAULT 'candidate',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  email TEXT,
  phone TEXT,
  outreach_status TEXT NOT NULL DEFAULT 'not_contacted',
  remarks TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_creator_registry_status ON creator_registry(qualification_status);
CREATE INDEX IF NOT EXISTS idx_creator_registry_niche ON creator_registry(niche);
`);

function ensureColumn(table, column, type) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
for (const [column,type] of [
  ["contact_company","TEXT"],
  ["secondary_contact_name","TEXT"],
  ["secondary_contact_role","TEXT"],
  ["secondary_contact_linkedin","TEXT"],
  ["secondary_phone","TEXT"],
  ["secondary_email","TEXT"],
  ["tertiary_contact_name","TEXT"],
  ["tertiary_contact_role","TEXT"],
  ["tertiary_contact_linkedin","TEXT"],
  ["tertiary_phone","TEXT"],
  ["tertiary_email","TEXT"]
]) ensureColumn("lead_master",column,type);

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
export function recordModelMetric(routeId, { success, latencyMs = 0, errorClass = null, errorMessage = null, cooldownMs = 0 }) {
  const at = now();
  db.prepare(`INSERT INTO model_metrics(route_id,calls,successes,failures,latency_ms_total,updated_at)
    VALUES(?,1,?,?,?,?)
    ON CONFLICT(route_id) DO UPDATE SET calls=calls+1, successes=successes+excluded.successes,
      failures=failures+excluded.failures, latency_ms_total=latency_ms_total+excluded.latency_ms_total,
      updated_at=excluded.updated_at`)
    .run(routeId, success ? 1 : 0, success ? 0 : 1, Math.max(0, Math.round(latencyMs)), at);

  const current = db.prepare("SELECT consecutive_failures FROM model_route_state WHERE route_id=?").get(routeId);
  const failures = success ? 0 : Number(current?.consecutive_failures || 0) + 1;
  const cooldownUntil = success || cooldownMs <= 0 ? null : new Date(Date.now() + cooldownMs).toISOString();
  db.prepare(`INSERT INTO model_route_state
    (route_id,consecutive_failures,cooldown_until,last_error_class,last_error,last_success_at,updated_at)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(route_id) DO UPDATE SET
      consecutive_failures=excluded.consecutive_failures,
      cooldown_until=excluded.cooldown_until,
      last_error_class=excluded.last_error_class,
      last_error=excluded.last_error,
      last_success_at=excluded.last_success_at,
      updated_at=excluded.updated_at`)
    .run(routeId, failures, cooldownUntil, success ? null : errorClass, success ? null : String(errorMessage || "").slice(0,500),
      success ? at : null, at);
}
export function modelMetrics() {
  return db.prepare("SELECT * FROM model_metrics").all().map(r => ({
    routeId:r.route_id, calls:r.calls, successes:r.successes, failures:r.failures,
    averageLatencyMs:r.calls ? Math.round(r.latency_ms_total/r.calls) : null, updatedAt:r.updated_at
  }));
}

export function modelRouteStates() {
  return db.prepare("SELECT * FROM model_route_state").all().map(row => ({
    routeId: row.route_id,
    consecutiveFailures: Number(row.consecutive_failures || 0),
    cooldownUntil: row.cooldown_until || null,
    lastErrorClass: row.last_error_class || null,
    lastError: row.last_error || null,
    lastSuccessAt: row.last_success_at || null,
    updatedAt: row.updated_at
  }));
}

const LEGAL_SUFFIXES = /\b(?:private|pvt|limited|ltd|llp|incorporated|inc|corporation|corp|company|co|technologies|technology|solutions|services)\b/g;
export function canonicalCompanyKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function cleanText(value) {
  const text = value === undefined || value === null ? "" : String(value).trim();
  return text || null;
}
function finiteInt(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}
function linkedinJobEvidence(input) {
  const job = cleanText(input.jobLink || input.job_link);
  const evidence = input.evidence && typeof input.evidence === "object" ? input.evidence : {};
  return Boolean(
    job &&
    /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/jobs\//i.test(job) &&
    (evidence.activeJobVerified === true || evidence.active_job_verified === true)
  );
}
function normalizeVerification(input) {
  const requested = String(input.verificationStatus || input.verification_status || "pending").toLowerCase();
  if (!["pending","verified","rejected"].includes(requested)) return "pending";
  if (requested === "verified") {
    if (String(input.source || "linkedin").toLowerCase() === "linkedin" && !linkedinJobEvidence(input)) {
      throw new Error("LEAD_VERIFICATION_REQUIRES_LINKEDIN_JOB_EVIDENCE");
    }
  }
  return requested;
}
function mapLead(row) {
  if (!row) return null;
  const primaryContact = {
    name: row.contact_name || null,
    role: row.contact_role || null,
    linkedin: row.contact_linkedin || null,
    company: row.contact_company || null,
    phone: row.phone || null,
    email: row.email || null
  };
  const secondaryContact = {
    name: row.secondary_contact_name || null,
    role: row.secondary_contact_role || null,
    linkedin: row.secondary_contact_linkedin || null,
    phone: row.secondary_phone || null,
    email: row.secondary_email || null
  };
  const tertiaryContact = {
    name: row.tertiary_contact_name || null,
    role: row.tertiary_contact_role || null,
    linkedin: row.tertiary_contact_linkedin || null,
    phone: row.tertiary_phone || null,
    email: row.tertiary_email || null
  };
  return {
    id: row.id,
    companyKey: row.company_key,
    companyName: row.company_name,
    companyLink: row.company_link || null,
    jobLink: row.job_link || null,
    jobTitle: row.job_title || null,
    location: row.location || null,
    employeeCount: row.employee_count ?? null,
    applicantCount: row.applicant_count ?? null,
    source: row.source,
    verificationStatus: row.verification_status,
    evidence: parse(row.evidence_json),
    contact: primaryContact,
    primaryContact,
    secondaryContact,
    tertiaryContact,
    remarks: row.remarks || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
export function upsertLead(input = {}) {
  const companyName = cleanText(input.companyName || input.company_name);
  if (!companyName) throw new Error("LEAD_COMPANY_NAME_REQUIRED");
  const companyKey = canonicalCompanyKey(companyName);
  if (!companyKey) throw new Error("LEAD_COMPANY_KEY_INVALID");
  const existing = db.prepare("SELECT * FROM lead_master WHERE company_key=?").get(companyKey);
  const verificationStatus = normalizeVerification(input);
  const evidence = input.evidence && typeof input.evidence === "object"
    ? { ...(existing ? parse(existing.evidence_json) : {}), ...input.evidence }
    : (existing ? parse(existing.evidence_json) : {});
  const at = now();
  const next = {
    id: existing?.id || input.id || `lead-${crypto.randomUUID()}`,
    companyKey,
    companyName,
    companyLink: cleanText(input.companyLink ?? input.company_link) ?? existing?.company_link ?? null,
    jobLink: cleanText(input.jobLink ?? input.job_link) ?? existing?.job_link ?? null,
    jobTitle: cleanText(input.jobTitle ?? input.job_title) ?? existing?.job_title ?? null,
    location: cleanText(input.location) ?? existing?.location ?? null,
    employeeCount: finiteInt(input.employeeCount ?? input.employee_count) ?? existing?.employee_count ?? null,
    applicantCount: finiteInt(input.applicantCount ?? input.applicant_count) ?? existing?.applicant_count ?? null,
    source: cleanText(input.source) ?? existing?.source ?? "linkedin",
    verificationStatus,
    evidence,
    contactName: cleanText(input.primaryContactName ?? input.contactName ?? input.contact_name) ?? existing?.contact_name ?? null,
    contactRole: cleanText(input.primaryContactRole ?? input.contactRole ?? input.contact_role) ?? existing?.contact_role ?? null,
    contactLinkedin: cleanText(input.primaryContactLinkedin ?? input.contactLinkedin ?? input.contact_linkedin) ?? existing?.contact_linkedin ?? null,
    contactCompany: cleanText(input.primaryContactCompany ?? input.contactCompany ?? input.contact_company) ?? existing?.contact_company ?? null,
    phone: cleanText(input.primaryPhone ?? input.phone) ?? existing?.phone ?? null,
    email: cleanText(input.primaryEmail ?? input.email) ?? existing?.email ?? null,
    secondaryContactName: cleanText(input.secondaryContactName ?? input.secondary_contact_name) ?? existing?.secondary_contact_name ?? null,
    secondaryContactRole: cleanText(input.secondaryContactRole ?? input.secondary_contact_role) ?? existing?.secondary_contact_role ?? null,
    secondaryContactLinkedin: cleanText(input.secondaryContactLinkedin ?? input.secondary_contact_linkedin) ?? existing?.secondary_contact_linkedin ?? null,
    secondaryPhone: cleanText(input.secondaryPhone ?? input.secondary_phone) ?? existing?.secondary_phone ?? null,
    secondaryEmail: cleanText(input.secondaryEmail ?? input.secondary_email) ?? existing?.secondary_email ?? null,
    tertiaryContactName: cleanText(input.tertiaryContactName ?? input.tertiary_contact_name) ?? existing?.tertiary_contact_name ?? null,
    tertiaryContactRole: cleanText(input.tertiaryContactRole ?? input.tertiary_contact_role) ?? existing?.tertiary_contact_role ?? null,
    tertiaryContactLinkedin: cleanText(input.tertiaryContactLinkedin ?? input.tertiary_contact_linkedin) ?? existing?.tertiary_contact_linkedin ?? null,
    tertiaryPhone: cleanText(input.tertiaryPhone ?? input.tertiary_phone) ?? existing?.tertiary_phone ?? null,
    tertiaryEmail: cleanText(input.tertiaryEmail ?? input.tertiary_email) ?? existing?.tertiary_email ?? null,
    remarks: cleanText(input.remarks) ?? existing?.remarks ?? null,
    createdAt: existing?.created_at || at,
    updatedAt: at
  };
  db.prepare(`INSERT INTO lead_master
    (id,company_key,company_name,company_link,job_link,job_title,location,employee_count,applicant_count,source,
     verification_status,evidence_json,contact_name,contact_role,contact_linkedin,contact_company,phone,email,
     secondary_contact_name,secondary_contact_role,secondary_contact_linkedin,secondary_phone,secondary_email,
     tertiary_contact_name,tertiary_contact_role,tertiary_contact_linkedin,tertiary_phone,tertiary_email,
     remarks,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(company_key) DO UPDATE SET
      company_name=excluded.company_name,
      company_link=excluded.company_link,
      job_link=excluded.job_link,
      job_title=excluded.job_title,
      location=excluded.location,
      employee_count=excluded.employee_count,
      applicant_count=excluded.applicant_count,
      source=excluded.source,
      verification_status=excluded.verification_status,
      evidence_json=excluded.evidence_json,
      contact_name=excluded.contact_name,
      contact_role=excluded.contact_role,
      contact_linkedin=excluded.contact_linkedin,
      contact_company=excluded.contact_company,
      phone=excluded.phone,
      email=excluded.email,
      secondary_contact_name=excluded.secondary_contact_name,
      secondary_contact_role=excluded.secondary_contact_role,
      secondary_contact_linkedin=excluded.secondary_contact_linkedin,
      secondary_phone=excluded.secondary_phone,
      secondary_email=excluded.secondary_email,
      tertiary_contact_name=excluded.tertiary_contact_name,
      tertiary_contact_role=excluded.tertiary_contact_role,
      tertiary_contact_linkedin=excluded.tertiary_contact_linkedin,
      tertiary_phone=excluded.tertiary_phone,
      tertiary_email=excluded.tertiary_email,
      remarks=excluded.remarks,
      updated_at=excluded.updated_at`)
    .run(next.id,next.companyKey,next.companyName,next.companyLink,next.jobLink,next.jobTitle,next.location,next.employeeCount,
      next.applicantCount,next.source,next.verificationStatus,JSON.stringify(next.evidence),next.contactName,next.contactRole,
      next.contactLinkedin,next.contactCompany,next.phone,next.email,next.secondaryContactName,next.secondaryContactRole,next.secondaryContactLinkedin,
      next.secondaryPhone,next.secondaryEmail,next.tertiaryContactName,next.tertiaryContactRole,next.tertiaryContactLinkedin,
      next.tertiaryPhone,next.tertiaryEmail,next.remarks,next.createdAt,next.updatedAt);
  addEvent({type: existing ? "lead.updated" : "lead.created", payload:{id:next.id,companyKey,status:next.verificationStatus}});
  return getLead(next.id);
}
export function getLead(idOrKey) {
  const raw = String(idOrKey || "").trim();
  if (!raw) return null;
  const row = raw.startsWith("lead-")
    ? db.prepare("SELECT * FROM lead_master WHERE id=?").get(raw)
    : db.prepare("SELECT * FROM lead_master WHERE company_key=?").get(canonicalCompanyKey(raw));
  return mapLead(row);
}
export function listLeads({ status = null, query = null, limit = 100 } = {}) {
  const clauses = [], args = [];
  if (status) { clauses.push("verification_status=?"); args.push(String(status)); }
  if (query) {
    clauses.push("(company_name LIKE ? OR location LIKE ? OR job_title LIKE ? OR contact_name LIKE ? OR contact_company LIKE ? OR secondary_contact_name LIKE ? OR tertiary_contact_name LIKE ?)");
    const q = `%${String(query).trim()}%`;
    args.push(q,q,q,q,q,q,q);
  }
  const sql = `SELECT * FROM lead_master${clauses.length ? " WHERE " + clauses.join(" AND ") : ""} ORDER BY updated_at DESC LIMIT ?`;
  args.push(Math.max(1,Math.min(1000,Number(limit)||100)));
  return db.prepare(sql).all(...args).map(mapLead);
}
export function leadStats(target = null) {
  const rows = db.prepare("SELECT verification_status, COUNT(*) AS count FROM lead_master GROUP BY verification_status").all();
  const counts = { total:0, verified:0, pending:0, rejected:0 };
  for (const row of rows) {
    const count = Number(row.count || 0);
    counts.total += count;
    if (row.verification_status in counts) counts[row.verification_status] = count;
  }
  const enriched = Number(db.prepare(`SELECT COUNT(*) AS count FROM lead_master
    WHERE verification_status='verified' AND (email IS NOT NULL OR phone IS NOT NULL OR secondary_email IS NOT NULL OR secondary_phone IS NOT NULL OR tertiary_email IS NOT NULL OR tertiary_phone IS NOT NULL)`).get()?.count || 0);
  const numericTarget = target === null || target === undefined || target === "" ? null : Math.max(0,Math.round(Number(target)||0));
  return { ...counts, enriched, target:numericTarget, remaining:numericTarget === null ? null : Math.max(0,numericTarget-counts.verified) };
}

export function canonicalCreatorKey(platform, handle) {
  const p=String(platform||"instagram").toLowerCase().replace(/[^a-z0-9]+/g,"").trim()||"instagram";
  const h=String(handle||"").trim()
    .replace(/^https?:\/\/(?:www\.)?instagram\.com\//i,"")
    .replace(/[/?#].*$/,"")
    .replace(/^@/,"")
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g,"");
  return h ? p+":"+h : "";
}
function mapCreator(row) {
  if(!row)return null;
  return {
    id:row.id,creatorKey:row.creator_key,platform:row.platform,handle:row.handle,
    profileUrl:row.profile_url||null,displayName:row.display_name||null,niche:row.niche||null,location:row.location||null,
    followerCount:row.follower_count??null,avgViews:row.avg_views??null,fitScore:row.fit_score??null,
    qualificationStatus:row.qualification_status,evidence:parse(row.evidence_json),
    email:row.email||null,phone:row.phone||null,outreachStatus:row.outreach_status,remarks:row.remarks||null,
    createdAt:row.created_at,updatedAt:row.updated_at
  };
}
function normalizeCreatorStatus(value) {
  const status=String(value||"candidate").toLowerCase();
  return ["candidate","qualified","rejected"].includes(status)?status:"candidate";
}
function creatorMetric(value,name,evidence) {
  if(value===undefined||value===null||value==="")return null;
  if(!evidence?.metricsObserved)throw new Error("CREATOR_METRIC_REQUIRES_OBSERVED_EVIDENCE:"+name);
  return finiteInt(value);
}
export function upsertCreator(input={}) {
  const platform=cleanText(input.platform)||"instagram";
  const rawHandle=cleanText(input.handle)||cleanText(input.profileUrl||input.profile_url);
  const creatorKey=canonicalCreatorKey(platform,rawHandle);
  if(!creatorKey)throw new Error("CREATOR_HANDLE_REQUIRED");
  const handle=creatorKey.split(":").slice(1).join(":");
  const existing=db.prepare("SELECT * FROM creator_registry WHERE creator_key=?").get(creatorKey);
  const evidence=input.evidence&&typeof input.evidence==="object"
    ?{...(existing?parse(existing.evidence_json):{}),...input.evidence}
    :(existing?parse(existing.evidence_json):{});
  const requestedStatus=normalizeCreatorStatus(input.qualificationStatus||input.qualification_status||existing?.qualification_status);
  if(requestedStatus==="qualified"&&!evidence.profileObserved)throw new Error("CREATOR_QUALIFICATION_REQUIRES_PROFILE_EVIDENCE");
  const incomingFollower=creatorMetric(input.followerCount??input.follower_count,"followerCount",evidence);
  const incomingViews=creatorMetric(input.avgViews??input.avg_views,"avgViews",evidence);
  const fitRaw=input.fitScore??input.fit_score;
  const fit=fitRaw===undefined||fitRaw===null||fitRaw===""?(existing?.fit_score??null):Math.max(0,Math.min(100,Math.round(Number(fitRaw)||0)));
  const at=now();
  const next={
    id:existing?.id||input.id||`creator-${crypto.randomUUID()}`,creatorKey,platform:String(platform).toLowerCase(),handle,
    profileUrl:cleanText(input.profileUrl??input.profile_url)??existing?.profile_url??(String(platform).toLowerCase()==="instagram"?`https://www.instagram.com/${handle}/`:null),
    displayName:cleanText(input.displayName??input.display_name)??existing?.display_name??null,
    niche:cleanText(input.niche)??existing?.niche??null,location:cleanText(input.location)??existing?.location??null,
    followerCount:incomingFollower??existing?.follower_count??null,avgViews:incomingViews??existing?.avg_views??null,fitScore:fit,
    qualificationStatus:requestedStatus,evidence,
    email:cleanText(input.email)??existing?.email??null,phone:cleanText(input.phone)??existing?.phone??null,
    outreachStatus:cleanText(input.outreachStatus??input.outreach_status)??existing?.outreach_status??"not_contacted",
    remarks:cleanText(input.remarks)??existing?.remarks??null,createdAt:existing?.created_at||at,updatedAt:at
  };
  db.prepare(`INSERT INTO creator_registry
    (id,creator_key,platform,handle,profile_url,display_name,niche,location,follower_count,avg_views,fit_score,
     qualification_status,evidence_json,email,phone,outreach_status,remarks,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(creator_key) DO UPDATE SET
      profile_url=excluded.profile_url,display_name=excluded.display_name,niche=excluded.niche,location=excluded.location,
      follower_count=excluded.follower_count,avg_views=excluded.avg_views,fit_score=excluded.fit_score,
      qualification_status=excluded.qualification_status,evidence_json=excluded.evidence_json,email=excluded.email,
      phone=excluded.phone,outreach_status=excluded.outreach_status,remarks=excluded.remarks,updated_at=excluded.updated_at`)
    .run(next.id,next.creatorKey,next.platform,next.handle,next.profileUrl,next.displayName,next.niche,next.location,
      next.followerCount,next.avgViews,next.fitScore,next.qualificationStatus,JSON.stringify(next.evidence),next.email,next.phone,
      next.outreachStatus,next.remarks,next.createdAt,next.updatedAt);
  addEvent({type:existing?"creator.updated":"creator.created",payload:{id:next.id,creatorKey,status:next.qualificationStatus}});
  return getCreator(next.id);
}
export function getCreator(idOrHandle,platform="instagram") {
  const raw=String(idOrHandle||"").trim();if(!raw)return null;
  const row=raw.startsWith("creator-")
    ?db.prepare("SELECT * FROM creator_registry WHERE id=?").get(raw)
    :db.prepare("SELECT * FROM creator_registry WHERE creator_key=?").get(canonicalCreatorKey(platform,raw));
  return mapCreator(row);
}
export function listCreators({status=null,niche=null,query=null,limit=100}={}) {
  const clauses=[],args=[];
  if(status){clauses.push("qualification_status=?");args.push(String(status));}
  if(niche){clauses.push("niche LIKE ?");args.push("%"+String(niche).trim()+"%");}
  if(query){clauses.push("(handle LIKE ? OR display_name LIKE ? OR niche LIKE ? OR location LIKE ?)");const q="%"+String(query).trim()+"%";args.push(q,q,q,q);}
  const sql=`SELECT * FROM creator_registry${clauses.length?" WHERE "+clauses.join(" AND "):""} ORDER BY updated_at DESC LIMIT ?`;
  args.push(Math.max(1,Math.min(1000,Number(limit)||100)));return db.prepare(sql).all(...args).map(mapCreator);
}
export function creatorStats(target=null) {
  const rows=db.prepare("SELECT qualification_status,COUNT(*) AS count FROM creator_registry GROUP BY qualification_status").all();
  const counts={total:0,candidate:0,qualified:0,rejected:0};
  for(const row of rows){const n=Number(row.count||0);counts.total+=n;if(row.qualification_status in counts)counts[row.qualification_status]=n;}
  const contacted=Number(db.prepare("SELECT COUNT(*) AS count FROM creator_registry WHERE outreach_status!='not_contacted'").get()?.count||0);
  const numericTarget=target===null||target===undefined||target===""?null:Math.max(0,Math.round(Number(target)||0));
  return{...counts,contacted,target:numericTarget,remaining:numericTarget===null?null:Math.max(0,numericTarget-counts.qualified)};
}
