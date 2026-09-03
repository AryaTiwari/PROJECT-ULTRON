const path = require('path');
const { execFileSync } = require('child_process');

function run(args, cwd, timeout = 15000) {
  return String(execFileSync('git', args, {
    cwd,
    windowsHide: true,
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) || '').trim();
}

function tryRun(args, cwd, timeout = 15000) {
  try { return { ok: true, stdout: run(args, cwd, timeout), error: null }; }
  catch (error) {
    const stderr = String(error?.stderr || '').trim();
    return { ok: false, stdout: String(error?.stdout || '').trim(), error: stderr || error.message };
  }
}

function shouldPublish(message) {
  return /\b(?:push(?:\s+it)?|commit(?:\s+it)?|publish(?:\s+it)?|update\s+(?:the\s+)?github|to\s+github|on\s+github|in\s+github|github\s+(?:repo|repository|branch)|ship\s+(?:it\s+)?to\s+github)\b/i.test(String(message || ''));
}

function repoRoot(workspace) {
  const result = tryRun(['rev-parse', '--show-toplevel'], workspace, 8000);
  return result.ok && result.stdout ? path.resolve(result.stdout) : null;
}

function branch(workspace) {
  const result = tryRun(['branch', '--show-current'], workspace, 8000);
  return result.ok ? result.stdout : '';
}

function redactRemote(remote) {
  const value = String(remote || '').trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
    }
    return url.toString();
  } catch {
    return value.replace(/https:\/\/[^@/]+@/i, 'https://');
  }
}

function changedPath(entry) {
  if (typeof entry === 'string') return entry;
  return String(entry?.path || entry?.file || entry?.filename || '').trim();
}

function safeFiles(workspace, root, changedFiles = []) {
  const files = [];
  for (const entry of changedFiles) {
    const raw = changedPath(entry);
    if (!raw) continue;
    const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspace, raw);
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    files.push(relative.replace(/\\/g, '/'));
  }
  return [...new Set(files)];
}

function status(workspace) {
  const cwd = path.resolve(workspace || process.cwd());
  const root = repoRoot(cwd);
  if (!root) return { ok: false, connected: false, reason: 'not-a-git-repository', workspace: cwd };
  const currentBranch = branch(root);
  const remoteResult = tryRun(['remote', 'get-url', 'origin'], root, 8000);
  const dirty = tryRun(['status', '--porcelain'], root, 8000);
  return {
    ok: Boolean(remoteResult.ok && remoteResult.stdout),
    connected: Boolean(remoteResult.ok && remoteResult.stdout),
    root,
    branch: currentBranch || null,
    remote: redactRemote(remoteResult.stdout),
    dirty: Boolean(dirty.stdout),
    remoteError: remoteResult.ok ? null : remoteResult.error,
  };
}

function probe(workspace) {
  const base = status(workspace);
  if (!base.connected || !base.branch) return { ...base, remoteReachable: false };
  const remote = tryRun(['ls-remote', '--heads', 'origin', base.branch], base.root, 12000);
  return {
    ...base,
    remoteReachable: remote.ok,
    remoteBranchFound: Boolean(remote.ok && remote.stdout),
    probeError: remote.ok ? null : remote.error,
  };
}

function messageFromTask(task) {
  const cleaned = String(task || '')
    .replace(/\b(?:please|ultron|sir)\b/gi, ' ')
    .replace(/\b(?:push|commit|publish|github|repository|repo)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.?!]+$/, '');
  const summary = (cleaned || 'apply verified coding changes').slice(0, 58).trim();
  return `feat(mark3): ${summary}`.slice(0, 72);
}

function publish({ workspace, changedFiles, task }) {
  const cwd = path.resolve(workspace || process.cwd());
  const root = repoRoot(cwd);
  if (!root) return { ok: false, published: false, reason: 'not-a-git-repository' };
  const currentBranch = branch(root);
  if (!currentBranch) return { ok: false, published: false, reason: 'detached-head' };

  const remoteResult = tryRun(['remote', 'get-url', 'origin'], root, 8000);
  if (!remoteResult.ok || !remoteResult.stdout) {
    return { ok: false, published: false, reason: 'origin-not-configured', error: remoteResult.error || null };
  }

  const files = safeFiles(cwd, root, changedFiles);
  if (!files.length) return { ok: false, published: false, reason: 'no-safe-changed-files' };

  const stagedBefore = tryRun(['diff', '--cached', '--name-only'], root, 8000);
  if (!stagedBefore.ok) return { ok: false, published: false, reason: 'cannot-inspect-index', error: stagedBefore.error };
  if (stagedBefore.stdout.trim()) {
    return {
      ok: false,
      published: false,
      reason: 'preexisting-staged-changes',
      staged: stagedBefore.stdout.split(/\r?\n/).filter(Boolean),
    };
  }

  const present = files.filter((file) => {
    const check = tryRun(['status', '--porcelain', '--', file], root, 8000);
    return check.ok && Boolean(check.stdout.trim());
  });
  if (!present.length) return { ok: false, published: false, reason: 'no-uncommitted-task-changes', files };

  const add = tryRun(['add', '--', ...present], root, 15000);
  if (!add.ok) return { ok: false, published: false, reason: 'git-add-failed', error: add.error, files: present };

  const staged = tryRun(['diff', '--cached', '--name-only'], root, 8000);
  const stagedFiles = staged.ok ? staged.stdout.split(/\r?\n/).filter(Boolean) : [];
  const unexpected = stagedFiles.filter((file) => !present.includes(file.replace(/\\/g, '/')));
  if (!staged.ok || unexpected.length) {
    tryRun(['restore', '--staged', '--', ...present], root, 8000);
    return { ok: false, published: false, reason: 'staging-scope-mismatch', unexpected, stagedFiles };
  }

  const commitMessage = messageFromTask(task);
  const commit = tryRun(['commit', '-m', commitMessage], root, 30000);
  if (!commit.ok) {
    tryRun(['restore', '--staged', '--', ...present], root, 8000);
    return { ok: false, published: false, reason: 'commit-failed', error: commit.error, files: present };
  }

  const commitSha = tryRun(['rev-parse', 'HEAD'], root, 8000).stdout || null;
  const push = tryRun(['push', 'origin', currentBranch], root, 60000);
  if (!push.ok) {
    return {
      ok: false,
      published: false,
      committed: true,
      commit: commitSha,
      branch: currentBranch,
      remote: redactRemote(remoteResult.stdout),
      reason: 'push-failed',
      error: push.error,
      files: present,
    };
  }

  return {
    ok: true,
    published: true,
    committed: true,
    commit: commitSha,
    branch: currentBranch,
    remote: redactRemote(remoteResult.stdout),
    files: present,
    message: commitMessage,
  };
}

module.exports = { shouldPublish, status, probe, publish, safeFiles, messageFromTask };
