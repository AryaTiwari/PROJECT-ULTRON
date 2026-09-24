'use strict';

const runtimeBuild = require('./runtime-build');

const VERSION = 'apollo-lead-benchmark-v1.0.0';
const SNAPSHOT_NAME = 'snapshot/apollo-lead-working-2026-09-24';

function shortRevision() {
  return String(runtimeBuild.revision || '').slice(0, 8) || 'unknown';
}

function stamp() {
  return `${VERSION} · build ${shortRevision()} · src ${runtimeBuild.fingerprint}`;
}

function annotate(body) {
  const value = String(body || '').trim();
  return value ? `${value}\n\n[${stamp()}]` : `[${stamp()}]`;
}

module.exports = Object.freeze({
  VERSION,
  SNAPSHOT_NAME,
  runtimeBuild,
  shortRevision,
  stamp,
  annotate,
});
