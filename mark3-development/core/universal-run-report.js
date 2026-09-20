'use strict';
const errors = require('./spreadsheet-enrichment-errors');
function build(result = {}) {
  const s = result.stats || {}, gate = result.completionGate || {};
  const pending = Number(s.phoneStillPending || 0) + Number(s.emailStillPending || 0);
  const state = result.completionState || (s.haltedEarly
    ? (s.haltError?.type === 'RATE_LIMIT' ? 'PARTIAL_PROVIDER_LIMIT' : 'PARTIAL_PROVIDER_UNAVAILABLE')
    : (gate.complete === false ? 'TERMINAL_DATA_EXHAUSTED' : pending ? 'COMPLETE_WITH_PENDING_CONTACTS' : result.completedFully ? 'COMPLETE' : 'TERMINAL_DATA_EXHAUSTED'));
  const issues = [...(gate.issues || []), ...(result.diagnostics || [])];
  const unresolved = [...new Set([
    ...issues.filter(i => i.rowNumber).map(i => `Row ${i.rowNumber}${i.target ? ', '+i.target : ''}: ${i.message || i.detail || 'Verification remains incomplete.'}`),
    ...(gate.contactGaps || []).map(i => `Row ${i.rowNumber}, POC-${i.groupOrdinal}: ${i.field} is ${pending ? 'unavailable or awaiting provider settlement' : 'unavailable from verified sources'}.`),
    ...(s.rowFailureAudit || []).map(i => `Row ${i.rowNumber}: ${errors.format(i)}`),
  ])];
  const ordinals = (result.schema?.personGroups || []).map(g=>Number(g.ordinal)).filter(Number.isFinite);
  const slots = [...new Set(ordinals)].sort((a,b)=>a-b).map(ordinal => {
    const missing = (gate.requiredIdentityIssues || []).filter(i=>i.groupOrdinal===ordinal).length;
    const gaps = (gate.contactGaps || []).filter(i=>i.groupOrdinal===ordinal).length;
    return `POC-${ordinal}: ${missing ? missing+' unresolved identities' : 'identities present'}${gaps ? ', '+gaps+' missing contact fields' : ''}`;
  });
  return [
    `${result.sheetName || 'Worksheet'} — ${state}`,
    result.validationMode || result.rowLimitApplied ? `Validation mode: up to ${result.rowLimitApplied || '?'} rows.` : 'Full-sheet mode.',
    `Rows processed: ${s.rowsProcessed || 0}. Rows changed: ${s.rowsChanged || 0}. Cells changed: ${s.cellsChanged || 0}.`,
    `Existing contacts repaired: ${s.existingGroupsRepaired || 0}. New contacts added: ${s.newPeopleSelected || 0}. Phone cells filled during settlement: ${s.phoneCellsFilled || 0}. Email cells filled during settlement: ${s.emailCellsFilled || 0}.`,
    `Pending phone lookups: ${s.phoneStillPending || 0}. Pending email lookups: ${s.emailStillPending || 0}.`,
    slots.join('; '),
    `Recorded activity: Apollo discovery ${s.candidateSearches || 0}, hydration attempts ${s.hydrationAttempts || 0}; public search ${s.publicIndexSearchCalls || 0}; AI calls ${result.modelCalls || 0}.`,
    s.haltError ? errors.format(s.haltError) : '',
    unresolved.length ? 'Unresolved work:\n'+unresolved.map(line=>'- '+line).join('\n') : '',
  ].filter(Boolean).join('\n\n');
}
module.exports = { build };
