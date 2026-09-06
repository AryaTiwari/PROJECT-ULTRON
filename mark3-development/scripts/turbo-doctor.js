const turbo = require('../core/turbo-engine');

const report = turbo.audit();

console.log(`ULTRON Turbo Doctor: ${report.state} — score ${report.score}/100`);
console.log(`Zero-cost guard: ${report.zeroCostGuard.enabled ? 'ON' : 'OFF'}; paid inference=${report.zeroCostGuard.paidInferenceAllowed ? 'ALLOWED' : 'blocked'}; local LLM=${report.zeroCostGuard.localLlmAllowed ? 'allowed' : 'blocked'}.`);

if (report.issues.length) {
  console.log('\nCRITICAL ISSUES');
  for (const row of report.issues) console.log(`- ${row.component}: ${row.reason}`);
} else {
  console.log('\nCRITICAL ISSUES\n- none');
}

if (report.warnings.length) {
  console.log('\nWARNINGS');
  for (const row of report.warnings.slice(0, 12)) console.log(`- ${row.component}: ${row.reason}`);
}

if (report.opportunities.length) {
  console.log('\nTOP OPPORTUNITIES');
  for (const row of report.opportunities.slice(0, 8)) console.log(`- [P${row.priority}] ${row.id}: ${row.reason}`);
}

console.log(`\nOperator ready: ${report.components.find((row) => row.name === 'operator')?.status?.ready?.map((row) => row.id).join(', ') || 'none'}`);
console.log(`Forge founder recipes: ${(report.forgeRecipes || []).join(', ') || 'none'}`);
console.log(`Ready free tools: ${report.freeTools.ready.map((row) => row.id).join(', ') || 'none'}`);
console.log(`Implemented tools waiting for credentials: ${report.freeTools.implementedWaitingCredentials.map((row) => row.id).join(', ') || 'none'}`);

if (report.issues.length) process.exitCode = 2;
