const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');
const policy = require('./linkedin-account-policy');

const WORKER = path.join(config.mark3Root, 'scripts', 'linkedin-joeyism-worker.py');
const DEFAULT_SESSION = path.join(config.projectRoot, '.ultron', 'credentials', 'linkedin-joeyism-session.json');

function enabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_LINKEDIN_JOEYISM_ENABLED || '0'));
}

function sessionPath() {
  return path.resolve(String(process.env.ULTRON_M3_LINKEDIN_JOEYISM_SESSION || DEFAULT_SESSION));
}

function pythonCommand() {
  return String(process.env.ULTRON_M3_PYTHON || (process.platform === 'win32' ? 'python.exe' : 'python3')).trim();
}

function equivalentTool(action) {
  if (action === 'person') return 'get_person_profile';
  if (action === 'company') return 'get_company_profile';
  if (action === 'job') return 'get_job_details';
  if (action === 'jobs') return 'search_jobs';
  throw new Error(`Unsupported LinkedIn fallback action: ${action}`);
}

function runWorker(payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonCommand(), [WORKER], {
      cwd: config.mark3Root,
      env: process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      const error = new Error(`Optional LinkedIn fallback timed out after ${timeoutMs}ms.`);
      error.code = 'LINKEDIN_JOEYISM_TIMEOUT';
      reject(error);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += String(chunk || ''); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk || '')).slice(-4000); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        return reject(new Error(stderr.trim() || `LinkedIn fallback exited with code ${code}.`));
      }
      try {
        resolve(JSON.parse(stdout.trim() || '{}'));
      } catch {
        reject(new Error(`LinkedIn fallback returned invalid JSON. ${stderr}`.trim()));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function call(action, args = {}) {
  if (!enabled()) {
    const error = new Error('The optional joeyism LinkedIn fallback is disabled.');
    error.code = 'LINKEDIN_JOEYISM_DISABLED';
    throw error;
  }
  const session = sessionPath();
  if (!fs.existsSync(session)) {
    const error = new Error('The optional LinkedIn fallback has no manual session. Run npm run linkedin:joeyism:setup first.');
    error.code = 'LINKEDIN_JOEYISM_AUTH_REQUIRED';
    throw error;
  }
  const tool = equivalentTool(action);
  await policy.waitTurn(tool);
  try {
    const response = await runWorker({
      action,
      session_path: session,
      ...args,
    }, Math.max(30000, Number(process.env.ULTRON_M3_LINKEDIN_JOEYISM_TIMEOUT_MS || 120000)));
    if (!response?.ok) {
      const error = new Error(response?.error || 'Optional LinkedIn fallback failed.');
      error.code = response?.error_kind === 'auth' ? 'LINKEDIN_JOEYISM_AUTH_REQUIRED' : 'LINKEDIN_JOEYISM_ERROR';
      throw error;
    }
    policy.recordCall(tool, true, { backend: 'joeyism' });
    return response.result;
  } catch (error) {
    const classification = policy.recordError(tool, error);
    error.linkedinSafety = classification;
    throw error;
  }
}

function status() {
  return {
    provider: 'joeyism/linkedin_scraper',
    enabled: enabled(),
    sessionReady: fs.existsSync(sessionPath()),
    sessionPath: sessionPath(),
    worker: WORKER,
    credentialsInEnv: false,
    manualSessionOnly: true,
    role: 'optional structured person/company/job-detail fallback',
  };
}

module.exports = {
  enabled,
  sessionPath,
  pythonCommand,
  equivalentTool,
  call,
  status,
};
