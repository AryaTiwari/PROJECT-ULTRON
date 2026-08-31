import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(projectRoot, 'interface-manifest.json');

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        httpsGet(res.headers.location, headers).then(resolve, reject);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
    });
    req.on('error', reject);
  });
}

async function fetchRaw(repository, ref, relativePath) {
  const encoded = relativePath.split('/').map(encodeURIComponent).join('/');
  const url = `https://raw.githubusercontent.com/${repository}/${ref}/${encoded}`;
  const result = await httpsGet(url, {
    'User-Agent': 'PROJECT-ULTRON-interface-sync',
    'Accept': 'text/plain,*/*;q=0.8',
  });
  if (result.statusCode === 200) return result.body;
  throw new Error(`Raw Interface1 download failed: HTTP ${result.statusCode} for ${relativePath}`);
}

async function fetchContents(repository, ref, relativePath) {
  const encoded = relativePath.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${repository}/contents/${encoded}?ref=${encodeURIComponent(ref)}`;
  const result = await httpsGet(url, {
    'User-Agent': 'PROJECT-ULTRON-interface-sync',
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  });
  if (result.statusCode !== 200) {
    throw new Error(`GitHub Contents API failed: HTTP ${result.statusCode} for ${relativePath}`);
  }
  let data;
  try { data = JSON.parse(result.body); } catch { throw new Error(`Invalid GitHub Contents API JSON for ${relativePath}`); }
  if (data?.encoding === 'base64' && typeof data?.content === 'string') {
    return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
  }
  if (typeof data?.content === 'string') return data.content;
  throw new Error(`GitHub Contents API returned no file content for ${relativePath}`);
}

async function fetchInterfaceFile(repository, ref, relativePath) {
  try {
    return await fetchRaw(repository, ref, relativePath);
  } catch (rawError) {
    console.warn(`[Interface] Raw fetch failed for ${relativePath}; using API fallback.`);
    try {
      return await fetchContents(repository, ref, relativePath);
    } catch (apiError) {
      throw new Error(`${rawError.message} | ${apiError.message}`);
    }
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
  server: { hmr: process.env.DISABLE_HMR !== 'true' },
  build: { outDir: path.resolve(__dirname, 'dist'), emptyOutDir: true },
});
`;

async function main() {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const targetRoot = path.join(projectRoot, manifest.root);

  console.log(`[Interface] Syncing CANONICAL Interface1 ${manifest.repository}@${manifest.ref} ...`);
  await fs.rm(targetRoot, { recursive: true, force: true });
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
  await fs.writeFile(path.join(targetRoot, '.interface-sync-version'), `${manifest.syncVersion || 'canonical-interface1'}\n`, 'utf8');
  console.log('[Interface] Canonical Interface1 globe synced successfully.');
}

main().catch((error) => {
  console.error(`[Interface] ${error.message}`);
  process.exitCode = 1;
});
