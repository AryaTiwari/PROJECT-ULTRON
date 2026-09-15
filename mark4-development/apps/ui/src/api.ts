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

export const api = {
  bootstrap: () => request("/api/bootstrap"),
  sessions: () => request("/api/sessions?limit=60&include_children=true"),
  createSession: (title = "ULTRON") => request("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ title })
  }),
  messages: (id: string) => request("/api/sessions/" + encodeURIComponent(id) + "/messages"),
  branch: (id: string, title = "Side branch", anchorMessageId?: string) =>
    request("/api/sessions/" + encodeURIComponent(id) + "/branch", {
      method: "POST",
      body: JSON.stringify({ title, ...(anchorMessageId ? { anchorMessageId } : {}) })
    }),
  mission: (id: string) => request("/api/missions/" + encodeURIComponent(id))
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

export async function streamChat(
  sessionId: string,
  input: Record<string, unknown>,
  onEvent: (type: string, data: any) => void
) {
  const response = await fetch(BASE + "/api/sessions/" + encodeURIComponent(sessionId) + "/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

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
    buffer += decoder.decode(value, { stream: true });

    let split;
    while ((split = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const evt = parseBlock(block);
      if (evt) onEvent(evt.type, evt.data);
    }
  }
}

export function liveEvents(onEvent: (type: string, data: any) => void) {
  const source = new EventSource(BASE + "/api/live");
  source.onmessage = event => {
    try { onEvent("message", JSON.parse(event.data)); } catch {}
  };

  const known = [
    "connected", "run.started", "run.settled", "run.failed",
    "tool.started", "tool.completed", "subagent.start", "subagent.complete",
    "assistant.delta", "assistant.completed", "message.started", "run.completed",
    "tool.progress", "tool.failed", "approval.required",
    "evidence.recorded", "mission.updated", "done"
  ];

  for (const type of known) {
    source.addEventListener(type, (event: any) => {
      try { onEvent(type, JSON.parse(event.data)); } catch {}
    });
  }

  return () => source.close();
}
