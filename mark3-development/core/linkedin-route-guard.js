function isExplicitLinkedInResearch(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!/\blinkedin\b|linkedin\.com\//i.test(value)) return false;

  const operational = /\b(?:find|get|search|research|source|collect|bring|list|show|look|pull|discover|scrape|extract|add|append|continue|resume|build|fill|edit|update|dedupe|consolidate|enrich|mission|progress|status|health|doctor|setup|login|authenticate|unlock|mcp)\b/i.test(value);
  const target = /\b(?:company|companies|job|jobs|role|roles|lead|leads|profile|profiles|people|person|recruiter|recruiters|founder|founders|hiring|master|sheet|spreadsheet|account|mission|mcp)\b/i.test(value);

  return operational && target;
}

function isExplicitLinkedInArtifactRequest(text) {
  const value = String(text || '').trim();
  if (!/\blinkedin\b|linkedin\.com\//i.test(value)) return false;

  // Strong file/media formats are unambiguous artifact requests when paired
  // with an explicit creation/delivery verb. Generic words such as "report"
  // alone are intentionally not enough because operational mission prompts
  // commonly contain headings like "Report:" or "report progress".
  const action = /\b(?:generate|create|make|render|design|produce|export|save|send|give|prepare|provide|deliver|turn|convert)\b/i;
  const strongFormat = /\b(?:pdf|docx|word document|word file|image|picture|poster|thumbnail|visual|wallpaper|artwork|logo|video|clip|animation|b-roll|broll)\b/i;
  if (action.test(value) && strongFormat.test(value)) return true;

  const genericArtifactPhrase = /\b(?:generate|create|make|export|save|send|give|prepare|provide|deliver)\s+(?:me\s+)?(?:a\s+|an\s+|the\s+)?(?:[^.\n]{0,48}\s+)?(?:document|report|brief|proposal)\b/i;
  return genericArtifactPhrase.test(value);
}

function isReservedLinkedInCommand(text) {
  return isExplicitLinkedInResearch(text) && !isExplicitLinkedInArtifactRequest(text);
}

module.exports = { isExplicitLinkedInResearch, isExplicitLinkedInArtifactRequest, isReservedLinkedInCommand };

let installed = false;
let originalHandle = null;

function install() {
  if (installed) return { installed: true, alreadyInstalled: true };
  const assistant = require('./assistant');
  const linkedin = require('./linkedin-account-bootstrap');
  originalHandle = assistant.handle;
  assistant.handle = async (message, options = {}) => {
    const text = String(message || '').trim();
    if (!isReservedLinkedInCommand(text)) return originalHandle(message, options);
    const status = linkedin.status();
    if (!status.installed) {
      return linkedin.responseShape(false, 'LinkedIn research is unavailable because the dedicated LinkedIn operator did not finish installing. ULTRON will not route this request to a general model. Restart after LinkedIn startup checks pass.', { linkedinRouteGuard: true, reason: 'linkedin_operator_not_installed' });
    }
    const result = await originalHandle(message, options);
    const model = String(result?.model || '').toLowerCase();
    const provider = String(result?.provider || '').toLowerCase();
    if (model !== 'linkedin-account-operator' && provider !== 'linkedin-account-mcp') {
      return linkedin.responseShape(false, 'LinkedIn research routing failed closed because the request escaped the dedicated LinkedIn operator. The general-model response was blocked.', { linkedinRouteGuard: true, reason: 'linkedin_route_escape_blocked', blockedModel: result?.model || null, blockedProvider: result?.provider || null });
    }
    return result;
  };
  installed = true;
  return { installed: true, failClosed: true };
}

function uninstall() {
  if (!installed || !originalHandle) return false;
  require('./assistant').handle = originalHandle;
  installed = false;
  originalHandle = null;
  return true;
}

module.exports = { isExplicitLinkedInResearch, isExplicitLinkedInArtifactRequest, isReservedLinkedInCommand, install, uninstall };
