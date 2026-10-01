import type { AttachmentRef } from "./types";

export const GATEWAY_URL = String(
  import.meta.env.VITE_ULTRON_GATEWAY_URL ||
  import.meta.env.VITE_ULTRON_API ||
  "http://127.0.0.1:8787"
).replace(/\/$/, "");

async function request(path: string, options: RequestInit = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(GATEWAY_URL + path, {
      ...options,
      signal: options.signal || controller.signal,
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error: any = new Error(data?.error || ("HTTP " + response.status));
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  } catch (error: any) {
    if (controller.signal.aborted) throw new Error("Gateway request timed out.");
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

const fileData = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error || new Error("FILE_READ_FAILED"));
  reader.onload = () => resolve(String(reader.result || "").split(",").at(-1) || "");
  reader.readAsDataURL(file);
});

export const api = {
  health: () => request("/api/health", {}, 3500),
  ready: () => request("/api/ready", {}, 6500),
  bootstrap: () => request("/api/bootstrap", {}, 10000),
  sessions: () => request("/api/sessions?limit=80&include_children=true"),
  createSession: (title = "ULTRON") => request("/api/sessions", { method: "POST", body: JSON.stringify({ title }) }),
  renameSession: (id: string, title: string) => request("/api/sessions/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify({ title }) }),
  messages: (id: string) => request("/api/sessions/" + encodeURIComponent(id) + "/messages"),
  branch: (id: string, title = "Side branch", anchorMessageId?: string) => request("/api/sessions/" + encodeURIComponent(id) + "/branch", { method: "POST", body: JSON.stringify({ title, ...(anchorMessageId ? { anchorMessageId } : {}) }) }),
  branchContext: (id: string) => request("/api/sessions/" + encodeURIComponent(id) + "/branch-context"),
  missions: () => request("/api/missions"),
  mission: (id: string) => request("/api/missions/" + encodeURIComponent(id)),
  createMission: (objective: string, originalRequest = objective) => request("/api/missions", { method: "POST", body: JSON.stringify({ objective, originalRequest, status: "planning" }) }),
  updateMission: (id: string, patch: Record<string, unknown>) => request("/api/missions/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify(patch) }),
  resumeMission: (id: string) => request("/api/missions/" + encodeURIComponent(id) + "/resume", { method: "POST", body: "{}" }),
  uploadAttachment: async (file: File): Promise<AttachmentRef> => request("/api/attachments", { method: "POST", body: JSON.stringify({ name: file.name, type: file.type, data: await fileData(file) }) }),
  approve: (runId: string, requestId: string, choice: string) => request("/api/runs/" + encodeURIComponent(runId) + "/approval", { method: "POST", body: JSON.stringify({ request_id: requestId, choice }) }),
  stopRun: (runId: string) => request("/api/runs/" + encodeURIComponent(runId) + "/stop", { method: "POST", body: "{}" }),
  telemetry: (type: string, data: Record<string, unknown> = {}) => request("/api/telemetry", { method: "POST", body: JSON.stringify({ type, data }) }),
  integrations: () => request("/api/integrations"),
  integrationAction: (id: string, action: string, data: Record<string, unknown> = {}) => request("/api/integrations/" + encodeURIComponent(id) + "/action", { method: "POST", body: JSON.stringify({ action, ...data }) }),
  missionParameter: (id: string, data: Record<string, unknown>) => request("/api/missions/" + encodeURIComponent(id) + "/parameters", { method: "POST", body: JSON.stringify(data) }),
  intelligence: () => request("/api/intelligence"),
  reflex: () => request("/api/reflex"),
  skills: () => request("/api/skills"),
  patternAction: (id: string, action: string, value?: unknown) => request("/api/patterns/" + encodeURIComponent(id) + "/action", { method: "POST", body: JSON.stringify({ action, value }) })
};

function parseBlock(block: string) {
  let type = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (!data.length) return null;
  const raw = data.join("\n");
  try { return { type, data: JSON.parse(raw) }; }
  catch { return { type, data: { raw } }; }
}

export async function streamChat(sessionId: string, input: Record<string, unknown>, onEvent: (type: string, data: any) => void) {
  const response = await fetch(GATEWAY_URL + "/api/sessions/" + encodeURIComponent(sessionId) + "/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error || ("HTTP " + response.status));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let split;
    while ((split = buffer.indexOf("\n\n")) >= 0) {
      const evt = parseBlock(buffer.slice(0, split));
      buffer = buffer.slice(split + 2);
      if (evt) onEvent(evt.type, evt.data);
    }
  }
  const trailing = parseBlock(buffer.trim());
  if (trailing) onEvent(trailing.type, trailing.data);
}

export type LiveConnection = (() => void) & { retry: () => void };

export function liveEvents(onEvent: (type: string, data: any) => void, onStatus?: (state: "online"|"recovering"|"offline") => void): LiveConnection {
  let source: EventSource | null = null, stopped = false, attempt = 0, timer = 0;
  const known = ["connected","request.received","model.selected","model.route_failed","skill.selected","parameters.compiled","parameter.missing","pattern.observed","pattern.confirmed","pattern.corrected","pattern.disabled","pattern.forgotten","purpose.linked","run.started","run.settled","run.failed","tool.started","tool.completed","subagent.start","subagent.complete","assistant.delta","assistant.completed","message.started","run.completed","run.cancelled","run.interrupted","tool.progress","tool.failed","approval.request","approval.required","approval.granted","operation.selected","target.resolved","auth.checking","auth.ready","apollo.search.started","apollo.search.page","apollo.search.completed","contact.company.processed","qualification.completed","deduplication.completed","selection.completed","sheet.write.started","sheet.write.completed","verification.completed","mission.blocked","mission.resumed","memory.loaded","evidence.recorded","mission.started","mission.updated","mission.completed","artifact.created","voice.listening","voice.transcribing","voice.transcribed","voice.speaking","voice.idle","screen.shared","screen.stopped","screen.permission_denied","error","done"];
  const connect = () => {
    if (stopped || source) return;
    source = new EventSource(GATEWAY_URL + "/api/live");
    source.onopen = () => { attempt = 0; onStatus?.("online"); };
    source.onmessage = event => { try { onEvent("message", JSON.parse(event.data)); } catch {} };
    for (const type of new Set(known)) source.addEventListener(type, (event: any) => { try { onEvent(type, JSON.parse(event.data)); } catch {} });
    source.onerror = () => {
      source?.close();
      source = null;
      if (stopped) return;
      attempt += 1;
      onStatus?.(attempt > 2 ? "offline" : "recovering");
      window.clearTimeout(timer);
      timer = window.setTimeout(connect, Math.min(15000, 1000 * 2 ** Math.min(attempt - 1, 4)));
    };
  };
  const close = (() => {
    stopped = true;
    window.clearTimeout(timer);
    source?.close();
    source = null;
  }) as LiveConnection;
  close.retry = () => {
    if (stopped) return;
    window.clearTimeout(timer);
    source?.close();
    source = null;
    attempt = 0;
    onStatus?.("recovering");
    connect();
  };
  connect();
  return close;
}
