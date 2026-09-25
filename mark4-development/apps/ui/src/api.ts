import type { AttachmentRef } from "./types";

const BASE = String(import.meta.env.VITE_ULTRON_API || "").replace(/\/$/, "");

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(BASE + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || ("HTTP " + response.status));
  return data;
}

const fileData = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error || new Error("FILE_READ_FAILED"));
  reader.onload = () => resolve(String(reader.result || "").split(",").at(-1) || "");
  reader.readAsDataURL(file);
});

export const api = {
  bootstrap: () => request("/api/bootstrap"),
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
  uploadAttachment: async (file: File): Promise<AttachmentRef> => request("/api/attachments", { method: "POST", body: JSON.stringify({ name: file.name, type: file.type, data: await fileData(file) }) }),
  approve: (runId: string, requestId: string, choice: string) => request("/api/runs/" + encodeURIComponent(runId) + "/approval", { method: "POST", body: JSON.stringify({ request_id: requestId, choice }) }),
  stopRun: (runId: string) => request("/api/runs/" + encodeURIComponent(runId) + "/stop", { method: "POST", body: "{}" })
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
  const response = await fetch(BASE + "/api/sessions/" + encodeURIComponent(sessionId) + "/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
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

export function liveEvents(onEvent: (type: string, data: any) => void) {
  const source = new EventSource(BASE + "/api/live");
  source.onmessage = event => { try { onEvent("message", JSON.parse(event.data)); } catch {} };
  const known = ["connected","run.started","run.settled","run.failed","tool.started","tool.completed","subagent.start","subagent.complete","assistant.delta","assistant.completed","message.started","run.completed","run.cancelled","run.interrupted","tool.progress","tool.failed","approval.request","model.route_failed","evidence.recorded","mission.updated","done"];
  for (const type of known) source.addEventListener(type, (event: any) => { try { onEvent(type, JSON.parse(event.data)); } catch {} });
  return () => source.close();
}
