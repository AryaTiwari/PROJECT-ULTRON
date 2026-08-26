const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('./config');

const ROOT = path.resolve(process.cwd());
const allowedRoots = [path.join(ROOT, 'core'), path.join(ROOT, 'tools'), path.join(ROOT, 'docs'), path.join(ROOT, 'interface')];

function isAllowedPath(relativePath) {
  const absolute = path.resolve(ROOT, relativePath);
  return allowedRoots.some(root => absolute === root || absolute.startsWith(`${root}${path.sep}`));
}

function inspectFile(relativePath) {
  if (!isAllowedPath(relativePath)) return { ok: false, error: 'Path outside self-maintenance allowlist.' };
  const absolute = path.resolve(ROOT, relativePath);
  if (!fs.existsSync(absolute)) return { ok: false, error: 'File not found.' };
  const stat = fs.statSync(absolute);
  return { ok: true, path: relativePath, size: stat.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') };
}

function createPatchPlan(changes = []) {
  if (!Array.isArray(changes) || !changes.length) return { ok: false, error: 'No proposed changes.' };
  const files = changes.map(change => inspectFile(change.path));
  const invalid = files.find(file => !file.ok);
  if (invalid) return invalid;
  return { ok: true, mode: 'plan-only', changes: changes.map(change => ({ path: change.path, reason: change.reason || 'maintenance', current: inspectFile(change.path) })) };
}

module.exports = { isAllowedPath, inspectFile, createPatchPlan };
