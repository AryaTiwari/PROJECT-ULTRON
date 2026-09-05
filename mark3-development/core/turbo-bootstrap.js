const assistant = require('./assistant');
const turbo = require('./turbo-engine');
const researchTurbo = require('./research-turbo-runtime');
const freeTools = require('./free-tool-registry');

let installed = false;
let originalHandle = null;

function isTurboStatus(text = '') {
  return /\b(?:turbo status|system health|ultron health|audit ultron|audit yourself|check yourself|system audit|what'?s broken|what is broken|runtime health)\b/i.test(String(text || ''));
}
function isFreeToolRequest(text = '') {
  return /\b(?:free tools?|free apis?|what api should i add|what integration should i add|integrations? can i add|tools? can i add|what should i connect|missing integrations?)\b/i.test(String(text || ''));
}
function isTopologyRequest(text = '') {
  return /\b(?:system map|feature map|integration map|how is ultron connected|what connects to what|runtime topology)\b/i.test(String(text || ''));
}

function statusResponse() {
  const report = turbo.audit();
  const compact = turbo.compact(report);
  const issue = compact.criticalIssue ? ` Critical issue: ${compact.criticalIssue}` : '';
  const opportunity = compact.topOpportunity ? ` Highest-leverage next addition: ${compact.topOpportunity.id} — ${compact.topOpportunity.reason}` : '';
  return `Sir, Turbo health is ${compact.score}/100 (${compact.state}). Ready operators: ${compact.operatorReady.join(', ') || 'none'}. Scaffolded operators: ${compact.operatorScaffolded.join(', ') || 'none'}.${issue}${opportunity}`;
}
function toolsResponse() {
  const rows = freeTools.nextRecommendations(7);
  if (!rows.length) return 'Sir, every high-priority zero-cost integration in the current Turbo registry is already configured.';
  const body = rows.map((row, index) => `${index + 1}. ${row.name} — ${row.purpose} Free: ${row.free}. Needs: ${row.missing.join(', ') || row.auth}.`).join('\n');
  return `Sir, these are the highest-leverage free integrations not yet configured:\n${body}\nI will never silently enable paid overages; zero-cost mode remains the hard default.`;
}
function topologyResponse() {
  const rows = turbo.topology().map((edge) => `${edge.from} → ${edge.to}: ${edge.contract}`);
  return `Sir, the current Mark3 runtime topology is:\n${rows.join('\n')}`;
}

async function handleSpecial(message, options = {}) {
  if (isTurboStatus(message)) {
    const response = statusResponse();
    return { ok: true, response, text: response, model: 'turbo-engine', provider: 'local', taskType: 'system-health', mode: 'turbo', inputMode: options.inputMode || 'chat', turbo: turbo.compact() };
  }
  if (isFreeToolRequest(message)) {
    const response = toolsResponse();
    return { ok: true, response, text: response, model: 'turbo-engine', provider: 'local', taskType: 'integration-planning', mode: 'turbo', inputMode: options.inputMode || 'chat', tools: freeTools.status() };
  }
  if (isTopologyRequest(message)) {
    const response = topologyResponse();
    return { ok: true, response, text: response, model: 'turbo-engine', provider: 'local', taskType: 'system-map', mode: 'turbo', inputMode: options.inputMode || 'chat' };
  }
  return null;
}

function install() {
  if (installed) return { installed: true, alreadyInstalled: true, research: researchTurbo.status(), turbo: turbo.compact() };
  researchTurbo.install();
  originalHandle = assistant.handle;
  assistant.handle = async (message, options = {}) => {
    const special = await handleSpecial(message, options);
    return special || originalHandle(message, options);
  };
  installed = true;
  return { installed: true, research: researchTurbo.status(), turbo: turbo.compact() };
}
function uninstall() {
  if (installed && originalHandle) assistant.handle = originalHandle;
  originalHandle = null;
  researchTurbo.uninstall();
  installed = false;
  return { installed: false };
}
function status() { return { installed, research: researchTurbo.status(), turbo: turbo.compact() }; }

module.exports = { isTurboStatus, isFreeToolRequest, isTopologyRequest, statusResponse, toolsResponse, topologyResponse, handleSpecial, install, uninstall, status };
