const fs = require('fs');
const path = require('path');
const https = require('https');
const { load: loadCredentials } = require('./credentials/local-store');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PROJECT_ENV = path.join(PROJECT_ROOT, '.env');
const REPO = String(process.env.GITHUB_REPOSITORY || 'AryaTiwari/PROJECT-ULTRON').replace(/^['"]|['"]$/g, '').trim();
const DEFAULT_BRANCH = String(process.env.GITHUB_BRANCH || 'mark2-development').replace(/^['"]|['"]$/g, '').trim();

function cleanSecret(value) {
  return String(value || '').replace(/^\uFEFF/, '').trim().replace(/^['"]|['"]$/g, '').trim();
}

function readProjectEnvValue(name) {
  try {
    const raw = fs.readFileSync(PROJECT_ENV, 'utf8').replace(/^\uFEFF/, '');
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match || match[1] !== name) continue;
      return cleanSecret(match[2]);
    }
  } catch {}
  return '';
}

async function token() {
  // Prefer the project's .env file so a stale Windows/system GITHUB_TOKEN
  // cannot silently override the token the user just configured for ULTRON.
  const projectToken = readProjectEnvValue('GITHUB_TOKEN');
  if (projectToken) return projectToken;

  const envCandidates = [process.env.GITHUB_TOKEN, process.env.GH_TOKEN]
    .map(cleanSecret)
    .filter(Boolean);
  if (envCandidates.length) return envCandidates[0];

  try {
    const stored = await loadCredentials();
    const storedToken = cleanSecret(stored.GITHUB_TOKEN || stored.GH_TOKEN);
    if (storedToken) return storedToken;
  } catch {}

  throw new Error('GITHUB_TOKEN is not configured in the ULTRON project environment or credential store.');
}

function request(method, urlPath, body = null) {
  return new Promise(async (resolve, reject) => {
    let authToken;
    try { authToken = await token(); } catch (error) { reject(error); return; }
    const bodyText = body == null ? null : JSON.stringify(body);
    const req = https.request({
      hostname: 'api.github.com', path: urlPath, method,
      headers: {
        'User-Agent': 'Project-Ultron', 'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'Authorization': `Bearer ${authToken}`,
        ...(bodyText ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyText) } : {}),
      },
    }, res => {
      let raw = ''; res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let data = {}; try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(data);
        const status = Number(res.statusCode || 0);
        if (status === 401) return reject(new Error('GitHub authentication failed (401 Bad credentials). The token from the ULTRON project environment was not accepted.'));
        if (status === 403) return reject(new Error(`GitHub authorization failed (403): ${data?.message || 'Forbidden'}. Verify repository access and fine-grained permissions.`));
        reject(new Error(data?.message || `GitHub API HTTP ${status}`));
      });
    });
    req.on('error', reject); req.setTimeout(20000, () => req.destroy(new Error('GitHub API request timed out.')));
    if (bodyText) req.write(bodyText); req.end();
  });
}

function encodedPath(repoPath) { return String(repoPath || '').split('/').filter(Boolean).map(encodeURIComponent).join('/'); }
function repoParts() { const [owner, repo] = REPO.split('/'); if (!owner || !repo) throw new Error('GITHUB_REPOSITORY must be in owner/repository format.'); return { owner, repo }; }

async function getRepo() { const { owner, repo } = repoParts(); const data = await request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`); return { name: data.full_name, default_branch: data.default_branch, private: data.private, html_url: data.html_url }; }
async function listFiles(input = {}) { const { owner, repo } = repoParts(); const ref = encodeURIComponent(input.ref || DEFAULT_BRANCH); const path = encodedPath(input.path || ''); const data = await request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}?ref=${ref}`); if (!Array.isArray(data)) throw new Error('Requested path is a file, not a directory.'); return data.map(item => ({ name: item.name, path: item.path, type: item.type, sha: item.sha })); }
async function readFile(input = {}) { const { owner, repo } = repoParts(); if (!input.path) throw new Error('GitHub file path is required.'); const ref = encodeURIComponent(input.ref || DEFAULT_BRANCH); const data = await request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath(input.path)}?ref=${ref}`); if (Array.isArray(data)) throw new Error('Requested path is a directory, not a file.'); const content = Buffer.from(String(data.content || '').replace(/\n/g, ''), 'base64').toString('utf8'); return { path: data.path, sha: data.sha, content, size: data.size, branch: input.ref || DEFAULT_BRANCH }; }
async function createFile(input = {}) { const { owner, repo } = repoParts(); if (!input.path) throw new Error('GitHub file path is required.'); if (input.content == null) throw new Error('GitHub file content is required.'); const branch = input.branch || DEFAULT_BRANCH; const data = await request('PUT', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath(input.path)}`, { message: input.message || `ULTRON: create ${input.path}`, content: Buffer.from(String(input.content), 'utf8').toString('base64'), branch }); return { path: data.content?.path || input.path, commit: data.commit?.sha, branch }; }
async function updateFile(input = {}) { const { owner, repo } = repoParts(); if (!input.path) throw new Error('GitHub file path is required.'); if (input.content == null) throw new Error('GitHub file content is required.'); const branch = input.branch || DEFAULT_BRANCH; let sha = input.sha; if (!sha) sha = (await readFile({ path: input.path, ref: branch })).sha; const data = await request('PUT', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath(input.path)}`, { message: input.message || `ULTRON: update ${input.path}`, content: Buffer.from(String(input.content), 'utf8').toString('base64'), sha, branch }); return { path: data.content?.path || input.path, previous_sha: sha, commit: data.commit?.sha, branch }; }

module.exports = { getRepo, listFiles, readFile, createFile, updateFile, repo: REPO, branch: DEFAULT_BRANCH };