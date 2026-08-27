import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(projectRoot, 'interface-manifest.json');

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'PROJECT-ULTRON-interface-sync' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return fetchText(response.headers.location).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Interface source download failed: HTTP ${response.statusCode} for ${url}`));
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(body));
    });
    request.on('error', reject);
  });
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const targetRoot = path.join(projectRoot, manifest.root);
  const versionFile = path.join(targetRoot, '.source-ref');
  const currentRef = await fs.readFile(versionFile, 'utf8').catch(() => '');

  if (currentRef.trim() === manifest.ref && (await fs.stat(path.join(targetRoot, 'src', 'main.tsx')).catch(() => null))) {
    console.log(`[Interface] Using cached Interface1 source ${manifest.ref}.`);
    return;
  }

  console.log(`[Interface] Syncing Interface1 ${manifest.repository}@${manifest.ref} ...`);
  await fs.mkdir(targetRoot, { recursive: true });

  for (const relativePath of manifest.files) {
    const url = `https://raw.githubusercontent.com/${manifest.repository}/${manifest.ref}/${relativePath}`;
    const destination = path.join(targetRoot, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const content = await fetchText(url);
    await fs.writeFile(destination, content, 'utf8');
    console.log(`[Interface] synced ${relativePath}`);
  }

  await fs.writeFile(versionFile, `${manifest.ref}\n`, 'utf8');
  console.log(`[Interface] Interface1 source ready at ${targetRoot}.`);
}

main().catch((error) => {
  console.error(`[Interface] ${error.message}`);
  process.exitCode = 1;
});
