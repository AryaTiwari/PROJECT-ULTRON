function isExplicitLinkedInResearch(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value.includes('linkedin')) return false;
  const action = ['find','search','research','source','collect','bring','list','add','continue','resume'].some(word => value.includes(word));
  const target = ['company','companies','job','jobs','role','roles','lead','leads','profile','profiles','recruiter','recruiters'].some(word => value.includes(word));
  return action && target;
}

module.exports = { isExplicitLinkedInResearch };

let installed = false;
let originalHandle = null;

function install() {
  if (installed) return { installed: true, alreadyInstalled: true };
  const assistant = require('./assistant');
  const linkedin = require('./linkedin-account-bootstrap');
  originalHandle = assistant.handle;
  assistant.handle = async (message, options = {}) => {
    const text = String(message || '').trim();
    if (!isExplicitLinkedInResearch(text)) return originalHandle(message, options);
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

module.exports = { isExplicitLinkedInResearch, install, uninstall };
