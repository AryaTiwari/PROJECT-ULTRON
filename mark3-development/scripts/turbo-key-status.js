const tools = require('../core/free-tool-registry');
const research = require('../core/research-turbo-runtime');

const status = tools.status();
console.log('ULTRON Turbo integration status');
console.log('Zero-cost guard: ON. Secret values are never printed.');
console.log(`Research: primary=${research.status().primary}; search fallbacks=${research.status().searchFallbacks.join(', ') || 'none credentialed'}; fetch fallbacks=${research.status().fetchFallbacks.join(', ')}.`);
console.log('');

for (const row of [...status.ready, ...status.implementedWaitingCredentials, ...status.dormant, ...status.scaffolded]
  .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))) {
  const state = row.ready
    ? 'READY'
    : row.dormant
      ? 'INSTALLED / DORMANT BY FOUNDER CHOICE'
      : row.implemented
        ? `IMPLEMENTED / NEEDS ${row.missing.join(', ') || row.auth}`
        : row.credentialsReady
          ? 'CREDENTIALS READY / CONNECTOR BUILD PENDING'
          : `PLANNED / NEEDS ${row.missing.join(', ') || row.auth}`;
  console.log(`${state.padEnd(58)} ${row.name}`);
}
