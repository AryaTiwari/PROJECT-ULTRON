import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(projectRoot, 'interface-manifest.json');

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        httpsGet(response.headers.location, headers).then(resolve, reject);
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode || 0, body }));
    });
    request.on('error', reject);
  });
}

async function fetchText(url) {
  const response = await httpsGet(url, { 'User-Agent': 'PROJECT-ULTRON-interface-sync', 'Accept': '*/*' });
  if (response.statusCode !== 200) throw new Error(`Interface source download failed: HTTP ${response.statusCode} for ${url}`);
  return response.body;
}

async function fetchGithubContents(repository, ref, relativePath) {
  const apiUrl = `https://api.github.com/repos/${repository}/contents/${relativePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
  const response = await httpsGet(apiUrl, { 'User-Agent': 'PROJECT-ULTRON-interface-sync', 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
  if (response.statusCode !== 200) throw new Error(`GitHub Contents API failed: HTTP ${response.statusCode} for ${apiUrl}`);
  let data;
  try { data = JSON.parse(response.body); } catch { throw new Error(`GitHub Contents API returned non-JSON data for ${relativePath}.`); }
  if (!data?.content) throw new Error(`GitHub Contents API returned no content for ${relativePath}.`);
  return Buffer.from(String(data.content).replace(/\n/g, ''), data.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
}

async function fetchInterfaceFile(repository, ref, relativePath) {
  const rawUrl = `https://raw.githubusercontent.com/${repository}/${ref}/${relativePath}`;
  try { return await fetchText(rawUrl); }
  catch (rawError) {
    console.warn(`[Interface] Raw download failed for ${relativePath}; using GitHub Contents API fallback.`);
    try { return await fetchGithubContents(repository, ref, relativePath); }
    catch (apiError) { throw new Error(`${rawError.message} | API fallback failed: ${apiError.message}`); }
  }
}

const localViteConfig = `import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
  server: { hmr: process.env.DISABLE_HMR !== 'true', watch: process.env.DISABLE_HMR === 'true' ? null : {} },
  build: { outDir: path.resolve(__dirname, 'dist'), emptyOutDir: true },
});
`;

async function syncInterfaceFiles(manifest, targetRoot) {
  console.log(`[Interface] Syncing canonical Interface1 ${manifest.repository}@${manifest.ref} ...`);
  await fs.mkdir(targetRoot, { recursive: true });
  for (const relativePath of manifest.files) {
    const destination = path.join(targetRoot, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const content = await fetchInterfaceFile(manifest.repository, manifest.ref, relativePath);
    await fs.writeFile(destination, content, 'utf8');
    console.log(`[Interface] synced ${relativePath}`);
  }
  await fs.writeFile(path.join(targetRoot, 'vite.config.ts'), localViteConfig, 'utf8');
  await fs.writeFile(path.join(targetRoot, '.source-ref'), `${manifest.ref}\n`, 'utf8');
  await fs.writeFile(path.join(targetRoot, '.interface-sync-version'), `${manifest.syncVersion || '1'}\n`, 'utf8');
  console.log(`[Interface] Canonical Interface1 source ready at ${targetRoot}.`);
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const targetRoot = path.join(projectRoot, manifest.root);
  const versionFile = path.join(targetRoot, '.source-ref');
  const syncVersionFile = path.join(targetRoot, '.interface-sync-version');
  const currentRef = await fs.readFile(versionFile, 'utf8').catch(() => '');
  const currentSyncVersion = await fs.readFile(syncVersionFile, 'utf8').catch(() => '');
  const entryExists = await fs.stat(path.join(targetRoot, 'src', 'main.tsx')).then(() => true).catch(() => false);
  const expectedSyncVersion = String(manifest.syncVersion || '1');
  if (currentRef.trim() === manifest.ref && currentSyncVersion.trim() === expectedSyncVersion && entryExists) {
    await fs.writeFile(path.join(targetRoot, 'vite.config.ts'), localViteConfig, 'utf8');
    console.log(`[Interface] Canonical Interface1 already current (${manifest.ref}).`);
    return;
  }
  await syncInterfaceFiles(manifest, targetRoot);
}

main().catch((error) => { console.error(`[Interface] ${error.message}`); process.exitCode = 1; });
