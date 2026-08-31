import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve('interface');
const projectRoot = process.cwd();
const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'interface-manifest.json'), 'utf8'));
const refFile = path.join(root, '.source-ref');
const versionFile = path.join(root, '.interface-sync-version');
const entryFile = path.join(root, 'src', 'main.tsx');
const currentRef = await fs.readFile(refFile, 'utf8').catch(() => '');
const currentVersion = await fs.readFile(versionFile, 'utf8').catch(() => '');
const ready = currentRef.trim() === String(manifest.ref).trim() && currentVersion.trim() === String(manifest.syncVersion || 'ultron-agent-ui-v2').trim() && await fs.stat(entryFile).then(() => true).catch(() => false);

if (ready) {
  console.log(`[Interface] Cache valid for Interface1 ${manifest.repository}@${manifest.ref}.`);
  process.exit(0);
}

const child = spawn(process.execPath, [path.join(projectRoot, 'scripts', 'sync-interface-v2.mjs')], { stdio: 'inherit' });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
