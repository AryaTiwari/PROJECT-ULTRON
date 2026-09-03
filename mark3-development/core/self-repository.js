const config = require('./config');
const integrations = require('./integrations');
const conversation = require('./conversation');
const { emit } = require('./events');

function isSelfRepositoryStatusIntent(text) {
  const value = String(text || '').toLowerCase().replace(/get\s+hub/g, 'github');
  const self = /\b(?:your|your own|own|ultron(?:'s)?|yourself|self)\b/.test(value);
  const repo = /\b(?:github|repo|repository|codebase|source|branch)\b/.test(value);
  const status = /\b(?:check|status|update|updated|latest|new|newer|version|commit|up[ -]?to[ -]?date|changes?)\b/.test(value);
  return self && repo && status;
}

function isIdentityIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  return /^(?:who|what)\s+are\s+you\??$/.test(value)
    || /\b(?:are you|you are)\s+(?:chatgpt|openai|cloud|a cloud ai)\b/.test(value)
    || /\bwhere\s+(?:do you|are you)\s+(?:run|live|hosted)\b/.test(value);
}

function cleanRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((item) => item && ['user', 'assistant'].includes(item.role) && String(item.content || '').trim());
}

function latestUserIsSelfRepository(rows) {
  const clean = cleanRows(rows);
  for (let i = clean.length - 1; i >= 0; i -= 1) {
    if (clean[i].role === 'user') return isSelfRepositoryStatusIntent(clean[i].content);
  }
  return false;
}

function continuationTargetsSelfRepository(message, suppliedHistory) {
  if (!conversation.isContinuation(message)) return false;

  // Persistent Mark 3 history is authoritative after a real browser timeout,
  // because the browser may never have added the failed command locally.
  const persisted = cleanRows(conversation.recent(10));
  if (latestUserIsSelfRepository(persisted)) return true;

  // Explicit history must still be independently usable for deterministic
  // tests and callers that provide a complete conversation snapshot.
  return latestUserIsSelfRepository(suppliedHistory);
}

function shortSha(value) {
  return String(value || '').slice(0, 7) || 'unknown';
}

function repositoryResponse(status) {
  const repoLabel = `${status.owner}/${status.repo}`;
  const latest = status.latest?.message ? ` The latest GitHub commit is ${shortSha(status.remoteHead)}, “${status.latest.message}”.` : ` The latest GitHub commit is ${shortSha(status.remoteHead)}.`;
  const dirty = status.dirty ? ' You also have uncommitted local changes.' : '';

  if (status.relationship === 'identical') {
    return `I checked my ${repoLabel} repository. This machine is already on the latest ${status.branch} commit, ${shortSha(status.remoteHead)}.${status.latest?.message ? ` It’s “${status.latest.message}”.` : ''}${dirty} What’s your next command?`;
  }
  if (status.relationship === 'ahead') {
    const count = Number.isFinite(status.aheadBy) && status.aheadBy > 0 ? ` by ${status.aheadBy} commit${status.aheadBy === 1 ? '' : 's'}` : '';
    return `I checked my GitHub. Yes, there’s a newer ${status.branch} update${count}. This machine is on ${shortSha(status.localHead)}, while GitHub is on ${shortSha(status.remoteHead)}.${latest}${dirty} What’s your next command?`;
  }
  if (status.relationship === 'behind') {
    return `I checked my GitHub. There isn’t a newer remote update; this local checkout is actually ahead of ${status.branch}. GitHub is on ${shortSha(status.remoteHead)}, while this machine is on ${shortSha(status.localHead)}.${dirty} What’s your next command?`;
  }
  if (status.relationship === 'diverged') {
    return `I checked my GitHub. The local checkout and ${status.branch} have diverged, so there are remote changes to sync as well as local changes to preserve. Local is ${shortSha(status.localHead)} and GitHub is ${shortSha(status.remoteHead)}.${latest}${dirty} What’s your next command?`;
  }
  return `I checked my GitHub. The local commit ${shortSha(status.localHead)} differs from the ${status.branch} commit ${shortSha(status.remoteHead)}, but I couldn’t safely determine the direction of the difference.${latest}${dirty} What’s your next command?`;
}

async function handle(message, suppliedHistory = null) {
  const userMessage = String(message || '').trim();
  const repoIntent = isSelfRepositoryStatusIntent(userMessage) || continuationTargetsSelfRepository(userMessage, suppliedHistory);
  if (!repoIntent && !isIdentityIntent(userMessage)) return null;

  conversation.append('user', userMessage, { taskType: repoIntent ? 'self-status' : 'identity', inputMode: 'system-fastpath' });

  if (isIdentityIntent(userMessage) && !repoIntent) {
    const response = `I’m ULTRON Mark 3, the local assistant runtime in ${config.githubOwner}/${config.githubRepo}. I run through your Project-Ultron system and use OmniRoute as model transport; I’m not ChatGPT pretending to be a separate cloud product. What’s your next command?`;
    conversation.append('assistant', response, { model: 'mark3-identity', provider: 'local', taskType: 'identity' });
    return { ok: true, response, text: response, model: 'mark3-identity', provider: 'local', taskType: 'identity', mode: 'deterministic' };
  }

  emit('tool_started', { tool: 'self_github_status', repo: `${config.githubOwner}/${config.githubRepo}`, branch: config.githubBranch });
  try {
    const status = await integrations.githubSelfStatus();
    const response = repositoryResponse(status);
    conversation.append('assistant', response, { model: 'deterministic-self-github', provider: 'github', taskType: 'self-status' });
    emit('tool_completed', { tool: 'self_github_status', repo: `${status.owner}/${status.repo}`, branch: status.branch, relationship: status.relationship, localHead: status.localHead, remoteHead: status.remoteHead });
    return { ok: true, response, text: response, model: 'deterministic-self-github', provider: 'github', taskType: 'self-status', mode: 'deterministic', repository: status };
  } catch (error) {
    emit('tool_failed', { tool: 'self_github_status', error: error.message });
    const response = `I know my repository is ${config.githubOwner}/${config.githubRepo} on ${config.githubBranch}, but I couldn’t reach GitHub to compare the local and remote commits. The exact error was: ${error.message}`;
    conversation.append('assistant', response, { model: 'deterministic-self-github-error', provider: 'github', taskType: 'self-status' });
    return { ok: false, response, text: response, model: 'deterministic-self-github-error', provider: 'github', taskType: 'self-status', mode: 'deterministic', error: error.message };
  }
}

module.exports = { handle, isSelfRepositoryStatusIntent, continuationTargetsSelfRepository, isIdentityIntent, repositoryResponse };
