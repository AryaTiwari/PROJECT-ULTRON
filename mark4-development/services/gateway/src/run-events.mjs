export function normalizeRunEvent(type, data = {}, runId = null) {
  const effectiveType = type === "message" && data?.event ? String(data.event) : type;
  const payload = { ...data };
  if (runId && !payload.run_id) payload.run_id = runId;
  if (effectiveType === "message.delta") return { type:"assistant.delta", data:payload };
  if (effectiveType === "approval.required") return { type:"approval.request", data:payload };
  return { type:effectiveType, data:payload };
}

export function isTerminalRunEvent(type) {
  return ["run.completed","run.failed","run.cancelled","run.interrupted"].includes(type);
}
