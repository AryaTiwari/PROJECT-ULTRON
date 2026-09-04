function endOfLocalDay(date) {
  const value = new Date(date); value.setHours(23, 59, 59, 999); return value.toISOString();
}
function dueAtFromText(message) {
  const text = String(message || '').toLowerCase();
  const now = new Date();
  if (/\btoday\b/.test(text)) return endOfLocalDay(now);
  if (/\btomorrow\b/.test(text)) { const date = new Date(now); date.setDate(date.getDate() + 1); return endOfLocalDay(date); }
  if (/\bthis week\b|\bby (?:the )?end of (?:the )?week\b/.test(text)) {
    const date = new Date(now); const day = date.getDay(); const days = day === 0 ? 0 : 7 - day; date.setDate(date.getDate() + days); return endOfLocalDay(date);
  }
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return endOfLocalDay(new Date(`${iso[1]}-${iso[2]}-${iso[3]}T12:00:00`));
  return null;
}
function priorityFromText(message) {
  const text = String(message || '').toLowerCase();
  if (/\bcritical\b|\basap\b|\bemergency\b/.test(text)) return 'critical';
  if (/\burgent\b|\bimportant\b|\btoday\b|\bmust\b/.test(text)) return 'high';
  if (/\blow priority\b|\bwhenever\b/.test(text)) return 'low';
  return 'medium';
}
function cleanTitle(value) {
  return String(value || '').replace(/\b(?:today|tomorrow|this week|by the end of the week)\b/gi, '').replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim();
}
function extractProject(message) {
  const match = String(message || '').match(/\b(?:for|on|in|with)\s+(Elevate(?: OS)?|Project ULTRON|ULTRON(?: Mark 3)?|BSc Physics|Physics|CU)\b/i);
  return match ? match[1] : null;
}
function extractWorkspaceMutation(message) {
  const text = String(message || '').trim();
  if (!text) return null;
  const project = extractProject(text);
  const priority = priorityFromText(text);
  const dueAt = dueAtFromText(text);

  let match = text.match(/^(?:done|finished|completed|fixed)\s+(.{3,180})$/i);
  if (!match) match = text.match(/^(.{3,180}?)\s+(?:is|are)\s+(?:done|finished|complete|completed|fixed|working now|working fine now)[.!?]*$/i);
  if (match) return { type: 'complete', query: cleanTitle(match[1]), project };

  match = text.match(/^(?:goal\s*:\s*|my goal is to\s+|our goal is to\s+)(.{3,180})$/i);
  if (match) return { type: 'create_goal', title: cleanTitle(match[1]), project, priority, dueAt, source: 'conversation' };

  match = text.match(/^(?:todo\s*:\s*|task\s*:\s*|i\s+need\s+to\s+|we\s+need\s+to\s+|i\s+must\s+|we\s+must\s+)(.{3,180})$/i);
  if (match) return { type: 'create_task', title: cleanTitle(match[1]), project, priority, dueAt, source: 'conversation' };

  match = text.match(/^(?:remind me to\s+|remember that i need to\s+|i\s+will\s+|i['’]ll\s+)(.{3,180})$/i);
  if (match) return { type: 'create_commitment', title: cleanTitle(match[1]), project, priority, dueAt, source: 'conversation' };

  match = text.match(/^(?:project\s*:\s*)(.{2,80})$/i);
  if (match) return { type: 'upsert_project', name: cleanTitle(match[1]), status: 'active', stage: 'active' };
  return null;
}
function extractCommitment(message) {
  const mutation = extractWorkspaceMutation(message);
  return mutation?.type === 'create_commitment'
    ? { title: mutation.title, priority: mutation.priority, dueAt: mutation.dueAt, project: mutation.project }
    : null;
}
function stripAssistantInvocation(message) {
  return String(message || '')
    .trim()
    .replace(/^(?:(?:hello|hey|hi|good\s+(?:morning|afternoon|evening))[,!\s-]*)?/i, '')
    .replace(/^ultron\b[\s,:;.!-]*/i, '')
    .trim();
}
function isStateBriefRequest(message) {
  const text = stripAssistantInvocation(message);
  if (!text) return false;
  if (/^(?:status|brief me|give me (?:a )?brief|what should i (?:do|work on)(?: first)?|what'?s next|what are my priorities|show my tasks|show my goals|what am i waiting (?:for|on)|what is pending)[?.!\s]*$/i.test(text)) return true;
  const asks = /\b(?:what|which|show|list|tell me|give me|do i have|are there|any)\b/i.test(text);
  const stateNoun = /\b(?:pending|task|tasks|todo|to-do|goal|goals|commitment|commitments|priority|priorities|blocked|waiting|deadline|deadlines|due|overdue|workspace|work)\b/i.test(text);
  const personal = /\b(?:my|our|i|we|for me|for us|today|tomorrow|this week|pending)\b/i.test(text);
  return asks && stateNoun && personal;
}
module.exports = { extractCommitment, extractProject, extractWorkspaceMutation, dueAtFromText, priorityFromText, isStateBriefRequest, stripAssistantInvocation };
