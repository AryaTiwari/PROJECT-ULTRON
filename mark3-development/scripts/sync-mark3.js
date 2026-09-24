'use strict';

const { execFileSync } = require('node:child_process');
const config = require('../core/config');

function git(args, options = {}) {
  try {
    return String(execFileSync('git', args, {
      cwd: config.projectRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: options.timeout || 20000,
      stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    }) || '').trim();
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const message = stderr || error?.message || 'git command failed';
    const wrapped = new Error(message);
    wrapped.code = 'MARK3_SYNC_GIT_FAILED';
    throw wrapped;
  }
}

function status() {
  const branch = git(['branch', '--show-current']);
  const head = git(['rev-parse', 'HEAD']);
  const dirty = git(['status', '--porcelain']);
  let origin = '';
  try { origin = git(['rev-parse', 'origin/mark3-development']); } catch {}
  return { branch, head, origin, dirty };
}

function sync() {
  const before = status();
  if (before.branch !== 'mark3-development') {
    throw new Error(`Refusing to sync from branch "${before.branch || 'detached'}". Checkout mark3-development first.`);
  }
  if (before.dirty) {
    throw new Error('Refusing to sync with uncommitted changes. Commit or stash them first.');
  }

  console.log('[Mark 3 sync] Fetching origin/mark3-development...');
  git(['fetch', 'origin', 'mark3-development'], { timeout: 30000, stdio: ['ignore', 'inherit', 'inherit'] });

  const fetched = status();
  if (fetched.head === fetched.origin) {
    console.log(`[Mark 3 sync] Already current at ${fetched.head.slice(0, 8)}.`);
    return fetched;
  }

  const ancestor = (() => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', fetched.head, fetched.origin], {
        cwd: config.projectRoot,
        windowsHide: true,
        timeout: 5000,
        stdio: 'ignore',
      });
      return true;
    } catch { return false; }
  })();

  if (!ancestor) {
    throw new Error(
      `Local mark3-development (${fetched.head.slice(0, 8)}) is not a fast-forward ancestor of origin (${fetched.origin.slice(0, 8)}). Preserve local work and rebase manually; no automatic merge was attempted.`
    );
  }

  git(['merge', '--ff-only', 'origin/mark3-development'], { timeout: 20000, stdio: ['ignore', 'inherit', 'inherit'] });
  const after = status();
  console.log(`[Mark 3 sync] Fast-forwarded to ${after.head.slice(0, 8)}.`);
  return after;
}

if (require.main === module) {
  try {
    const result = sync();
    console.log(JSON.stringify({
      ok: true,
      branch: result.branch,
      head: result.head,
      origin: result.origin,
      current: result.head === result.origin,
    }, null, 2));
  } catch (error) {
    console.error(`[Mark 3 sync] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { git, status, sync };
