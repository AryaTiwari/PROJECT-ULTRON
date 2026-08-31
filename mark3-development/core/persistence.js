const fs = require('fs');
const path = require('path');

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    ensureParent(file);
    fs.writeFileSync(file, JSON.stringify(fallback, null, 2), 'utf8');
    return structuredClone(fallback);
  }
}

function writeJsonAtomic(file, value) {
  ensureParent(file);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

function appendJsonl(file, value) {
  ensureParent(file);
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

module.exports = { readJson, writeJsonAtomic, appendJsonl, readJsonl };
