#!/usr/bin/env node
// Read-only local recovery diagnostic. Never starts MCP, calls LinkedIn,
// touches Google Sheets, or mutates mission state.
const fs = require('fs');
const path = require('path');
const config = require('../core/config');
const runner = require('../core/linkedin-mission-runner');

const missionId = String(process.argv[2] || '').trim();
if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(missionId)) {
  throw new Error('Usage: npm run linkedin:recover-diagnostic -- <mission-id>');
}

const ignored = new Set(['node_modules', '.git', 'dist', 'build', '.cache']);
const roots = [
  path.join(config.projectRoot, '.ultron'),
  path.join(config.mark3Root, '.ultron'),
  path.join(config.projectRoot, 'data'),
  path.join(config.mark3Root, 'data'),
].filter((value, index, all) => all.indexOf(value) === index && fs.existsSync(value));

const exactFiles = [];
const containingFiles = [];
function walk(dir, depth = 0) {
  if (depth > 6) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, depth + 1);
      continue;
    }
    if (!entry.isFile() || !/\.(?:json|jsonl|ndjson|bak|tmp)$/i.test(entry.name)) continue;
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.size > 25 * 1024 * 1024) continue;
    if (entry.name.toLowerCase().startsWith(missionId.toLowerCase())) exactFiles.push(full);
    try {
      const raw = fs.readFileSync(full, 'utf8');
      if (raw.includes(missionId)) containingFiles.push(full);
    } catch {}
  }
}
roots.forEach((root) => walk(root));

let currentMission = null;
try { currentMission = runner.get(missionId); } catch {}

const saved = runner.list();
const compatible = runner.recoverySourceMissions(
  `Resume LinkedIn mission ${missionId}. Target SAP-hiring companies in Maharashtra or Bengaluru.`
).map((item) => ({
  id: item.mission.id,
  status: item.mission.status,
  score: item.score,
  searchResponses: item.searchCount,
  cachedResponses: item.responseCount,
  locationOverlap: item.locationOverlap,
  topic: item.mission.prepared?.request?.topic || null,
  entityMode: item.mission.prepared?.request?.entityMode || null,
  locations: item.mission.prepared?.request?.allowedLocations
    || item.mission.prepared?.request?.preferredLocations
    || [item.mission.prepared?.request?.location].filter(Boolean),
}));

let operatorMatch = null;
const operatorState = path.join(config.projectRoot, '.ultron', 'linkedin-account', 'operator-state.json');
if (fs.existsSync(operatorState)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(operatorState, 'utf8'));
    const match = (parsed.missions || []).find((mission) => String(mission?.id || '') === missionId);
    if (match) {
      operatorMatch = {
        id: match.id,
        status: match.status || null,
        createdAt: match.createdAt || null,
        completedAt: match.completedAt || null,
        topic: match.request?.topic || null,
        entityMode: match.request?.entityMode || null,
        verifiedRecords: Array.isArray(match.verifiedRecords) ? match.verifiedRecords.length : 0,
        checkedJobIds: Array.isArray(match.toolCalls?.checkedJobIds) ? match.toolCalls.checkedJobIds.length : 0,
        sheetUrlPresent: Boolean(match.sheetUrl),
      };
    }
  } catch {}
}

console.log(JSON.stringify({
  missionId,
  projectRoot: config.projectRoot,
  currentMissionStore: path.join(config.projectRoot, '.ultron', 'linkedin-missions'),
  currentMissionFound: Boolean(currentMission),
  currentMission: currentMission ? {
    id: currentMission.id,
    status: currentMission.status,
    responses: Object.keys(currentMission.responses || {}).length,
    searchResponses: Object.keys(currentMission.responses || {}).filter((key) => {
      try { return JSON.parse(key)[0] === 'search_jobs'; } catch { return false; }
    }).length,
  } : null,
  scannedRoots: roots,
  exactFiles: [...new Set(exactFiles)],
  filesContainingMissionId: [...new Set(containingFiles)],
  operatorStateMatch: operatorMatch,
  missionFilesInCurrentStore: saved.length,
  compatibleSavedEvidence: compatible.slice(0, 12),
  recoveryPossible: Boolean(currentMission || compatible.length),
  note: compatible.length
    ? 'If the exact runner mission file is missing, the patched resume path can create a saved-evidence-only recovery continuation from these compatible mission caches.'
    : 'No compatible runner cache was found. Do not fabricate recovery; inspect exact/containing files or allow a fresh authenticated LinkedIn mission explicitly.'
}, null, 2));
