const fs = require('fs');
const { UltronCore } = require('./ultron-core');
const { execute } = require('./executor');

function extractUrl(text) {
  const match = String(text).match(/https?:\/\/[^\s]+/i);
  return match ? match[0].replace(/[),.!?]+$/, '') : null;
}

function parseToolIntent(message) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();
  if (/^(open|launch)\s+https?:\/\//i.test(text)) return { name: 'open_url', input: { url: extractUrl(text) } };
  if (/^(show|list)\s+(files|folders|directory|files in)/i.test(text)) {
    const pathMatch = text.match(/(?:in|of|at)\s+(.+)$/i);
    return { name: 'list_directory', input: { path: pathMatch ? pathMatch[1].replace(/^['"]|['"]$/g, '') : '.' } };
  }
  if (/^(what('?s| is) my (computer|pc) (spec|system|hardware)|system info|computer info)$/i.test(text)) return { name: 'system_info', input: {} };
  if (/^read file\s+/i.test(text)) return { name: 'read_file', input: { path: text.replace(/^read file\s+/i, '').trim() } };
  if (/^write file\s+/i.test(text)) return { name: 'write_file', input: JSON.parse(text.replace(/^write file\s+/i, '').trim()) };
  if (/^run powershell\s+/i.test(text)) return { name: 'run_powershell', input: { command: text.replace(/^run powershell\s+/i, '').trim() } };
  return null;
}

class Mark2Runtime extends UltronCore {
  async handleMessage(message, options = {}) {
    const intent = parseToolIntent(message);
    if (!intent) return super.handleMessage(message, options);
    const guardian = require('./guardian').assess({ message, action: intent.name === 'run_powershell' || intent.name === 'write_file' ? { destructive: true, requiresConfirmation: true } : null });
    const critic = require('./critic').analyze({ message, plannedAction: intent.name === 'run_powershell' || intent.name === 'write_file' ? { destructive: true, externalSideEffect: true } : null }, guardian);
    if (guardian.decision === 'block') return { ok: true, blocked: true, response: guardian.reasons.join(' '), guardian, critic };
    if (guardian.decision === 'warn' && options.confirmed !== true) return { ok: true, requires_confirmation: true, response: `Guardian warning: ${guardian.reasons.join(' ')}`, guardian, critic, tool: intent };
    const result = await execute(intent.name, intent.input, { confirmed: options.confirmed === true, source: options.source || 'core' });
    return { ok: result.ok, response: result.ok ? `${intent.name} completed.` : result.error, tool_result: result, guardian, critic };
  }
}

module.exports = { Mark2Runtime, parseToolIntent };
