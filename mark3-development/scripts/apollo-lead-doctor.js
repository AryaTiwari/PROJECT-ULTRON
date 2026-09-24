'use strict';

const { execFileSync } = require('node:child_process');
const config = require('../core/config');
const contract = require('../core/apollo-lead-contract');
const control = require('../core/command-control-plane');
const missionStore = require('../core/apollo-lead-mission-store');
const aliases = require('../core/sheet-source-alias-store');

function git(args) {
  try {
    return String(execFileSync('git', args, {
      cwd: config.projectRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }) || '').trim();
  } catch {
    return '';
  }
}

async function serverRuntime() {
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/api/runtime`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

(async () => {
  const head = git(['rev-parse', 'HEAD']);
  const branch = git(['branch', '--show-current']);
  const originHead = git(['rev-parse', 'origin/mark3-development']);
  const dirty = git(['status', '--porcelain']);
  const server = await serverRuntime();
  const route = control.claim('Apollo lead progress');
  const latest = missionStore.latest();

  const report = {
    ok: true,
    contract: contract.VERSION,
    source: {
      branch,
      head,
      runtimeBuildId: contract.runtimeBuild.id,
      fingerprint: contract.runtimeBuild.fingerprint,
      dirty: Boolean(dirty),
      dirtyFiles: dirty ? dirty.split(/\r?\n/).filter(Boolean) : [],
    },
    origin: {
      mark3Development: originHead || null,
      sourceMatchesOrigin: Boolean(originHead && head === originHead),
    },
    runningServer: server ? {
      buildId: server.buildId || null,
      revision: server.revision || null,
      sourceFingerprint: server.sourceFingerprint || null,
      sourceMatchesRunningServer: Boolean(
        server.revision
        && server.sourceFingerprint
        && server.revision === contract.runtimeBuild.revision
        && server.sourceFingerprint === contract.runtimeBuild.fingerprint
      ),
    } : null,
    routeInvariant: {
      phrase: 'Apollo lead progress',
      domain: route.domain,
      controller: route.controller,
      exclusive: route.exclusive,
      generalModelAllowed: route.generalModelAllowed,
      pass: route.domain === 'apollo-lead'
        && route.controller === 'apollo-lead-domain-controller'
        && route.exclusive === true
        && route.generalModelAllowed === false,
    },
    sheetAliases: aliases.list(),
    latestMission: latest ? {
      missionId: latest.missionId,
      phase: latest.currentPhase,
      contractVersion: latest.contractVersion || null,
      runtimeBuildId: latest.runtimeBuildId || null,
      rowsWritten: latest.rowsWritten || 0,
      companiesQualified: latest.companiesQualified || 0,
      lastError: latest.lastError || null,
    } : null,
  };

  if (!report.routeInvariant.pass) report.ok = false;
  if (server && !report.runningServer.sourceMatchesRunningServer) report.ok = false;

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
