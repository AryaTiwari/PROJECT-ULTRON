'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const config = require('./config');

function filesUnder(root) {
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...filesUnder(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) output.push(full);
  }
  return output;
}

function gitRevision() {
  try {
    return String(execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: config.projectRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }) || '').trim();
  } catch { return ''; }
}

function sourceFingerprint() {
  const files = [path.join(config.mark3Root, 'server.js'), path.join(config.mark3Root, 'package.json'), ...filesUnder(path.join(config.mark3Root, 'core'))]
    .filter((file) => fs.existsSync(file))
    .sort();
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(config.mark3Root, file).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

const revision = gitRevision();
const fingerprint = sourceFingerprint();
const id = `${revision || 'unknown'}:${fingerprint}`;
module.exports = Object.freeze({ id, revision, fingerprint });