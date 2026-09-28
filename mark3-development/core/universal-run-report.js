'use strict';
const errors = require('./spreadsheet-enrichment-errors');

const MAX_DIAGNOSTIC_GROUPS = Math.max(3, Math.min(12, Number(process.env.ULTRON_M3_REPORT_MAX_DIAGNOSTIC_GROUPS || 8)));
const MAX_SAMPLE_ROWS = Math.max(3, Math.min(12, Number(process.env.ULTRON_M3_REPORT_MAX_SAMPLE_ROWS || 8)));

function text(value) { return String(value == null ? '' : value).trim(); }

function issueGroupKey(issue = {}) {
  return [
    text(issue.target) || 'ROW',
    text(issue.problem) || 'Enrichment issue',
    text(issue.explanation),
    text(issue.action),
  ].join('|');
}

function groupIssues(issues = []) {
  const groups = new Map();
  for (const issue of Array.isArray(issues) ? issues : []) {
    const key = issueGroupKey(issue);
    if (!groups.has(key)) {
      groups.set(key, {
        target: text(issue.target),
        problem: text(issue.problem) || 'Enrichment issue',
        explanation: text(issue.explanation) || 'The required evidence did not pass verification.',
        action: text(issue.action) || 'Provide additional verified evidence or retry only the affected stage.',
        rows: new Set(),
        occurrences: 0,
      });
    }
    const group = groups.get(key);
    group.occurrences++;
    const row = Number(issue.rowNumber);
    if (Number.isInteger(row)) group.rows.add(row);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      rows: [...group.rows].sort((a, b) => a - b),
    }))
    .sort((a, b) => {
      const aCount = a.rows.length || a.occurrences;
      const bCount = b.rows.length || b.occurrences;
      return bCount - aCount || a.problem.localeCompare(b.problem);
    });
}

function rowSample(rows = [], limit = MAX_SAMPLE_ROWS) {
  const values = [...new Set((Array.isArray(rows) ? rows : [])
    .map(Number)
    .filter(Number.isInteger))]
    .sort((a, b) => a - b);
  const shown = values.slice(0, limit);
  const more = Math.max(0, values.length - shown.length);
  return {
    count: values.length,
    text: shown.length
      ? `${shown.join(', ')}${more ? ` (+${more} more)` : ''}`
      : 'none',
  };
}

function formatIssueGroup(group = {}) {
  const sample = rowSample(group.rows);
  const target = group.target ? `${group.target}: ` : '';
  const affected = sample.count
    ? `${sample.count} row${sample.count === 1 ? '' : 's'} affected`
    : `${group.occurrences || 1} occurrence${Number(group.occurrences || 1) === 1 ? '' : 's'}`;
  const rows = sample.count ? ` Sample rows: ${sample.text}.` : '';
  return `- ${target}${affected}. Problem: ${group.problem}.${rows} Explanation: ${group.explanation} What to do: ${group.action}`;
}

function compactIssues(issues = []) {
  const groups = groupIssues(issues);
  if (!groups.length) return '';
  const shown = groups.slice(0, MAX_DIAGNOSTIC_GROUPS);
  const hidden = groups.slice(MAX_DIAGNOSTIC_GROUPS);
  const hiddenOccurrences = hidden.reduce((sum, group) => sum + Number(group.rows.length || group.occurrences || 0), 0);
  const lines = [
    `Unresolved summary: ${issues.length} row-level diagnostic event${issues.length === 1 ? '' : 's'} collapsed into ${groups.length} issue categor${groups.length === 1 ? 'y' : 'ies'}.`,
    ...shown.map(formatIssueGroup),
  ];
  if (hidden.length) {
    lines.push(`- Additional diagnostic categories: ${hidden.length}, covering ${hiddenOccurrences} row event${hiddenOccurrences === 1 ? '' : 's'}. Full row-level diagnostics remain in the durable mission state and are not printed in chat.`);
  }
  return lines.join('\n');
}

function build(result = {}) {
 const s=result.stats||{},m=result.metrics||{},gate=result.completionGate||{},pending=m.pending||[];
 const state=result.completionState||require('./universal-completion-state').decide(result);
 const issues=(gate.issues||[]).map(i=>({rowNumber:i.rowNumber,target:i.target,problem:i.message,explanation:i.detail||'The required evidence did not pass verification.',action:i.nextAction||'Provide additional verified evidence or retry the affected row.'}));
 for(const gap of gate.contactGaps||[]){const awaiting=pending.some(p=>Number(p.rowNumber)===Number(gap.rowNumber)&&Number(p.groupOrdinal)===Number(gap.groupOrdinal)&&p.kind===gap.field);
  issues.push({rowNumber:gap.rowNumber,target:'POC-'+gap.groupOrdinal,problem:awaiting?`Apollo ${gap.field} lookup is still pending.`:`Verified ${gap.field} is unavailable.`,explanation:awaiting?'The paid request has been saved with this exact contact owner.':'No safe contact value was returned for this person.',action:awaiting?'Allow callback recovery to finish; do not purchase the lookup again.':'Leave the field blank or provide a verified source.'});
 }
 for(const failure of s.rowFailureAudit||[]){const typed=errors.normalize(Object.assign(new Error(failure.message),failure));issues.push({rowNumber:failure.rowNumber,target:failure.target||'',problem:typed.humanTitle,explanation:typed.humanExplanation,action:typed.hint});}
 const seen=new Set(),unique=issues.filter(i=>{const key=[i.rowNumber??'',i.target||'',i.problem||''].join('|');if(seen.has(key))return false;seen.add(key);return true;});
 const poc=(result.schema?.personGroups||[]).map(g=>{const missing=(gate.requiredIdentityIssues||[]).filter(i=>i.groupOrdinal===g.ordinal).length;const contacts=(gate.contactGaps||[]).filter(i=>i.groupOrdinal===g.ordinal).length;return `POC-${g.ordinal}: ${missing?missing+' unresolved identities':'identities present'}${contacts?', '+contacts+' missing contact fields':''}.`;});
 const count=(field,fallback)=>m[field]??s[fallback||field]??0;
 const calls=m.providerCalls||{};
 return [
  `${result.sheetName||'Worksheet'} — ${state}`,
  result.validationMode||result.rowLimitApplied?`Validation mode: up to ${result.rowLimitApplied} rows.`:'Full-sheet mode.',
  `Rows processed: ${count('rowsProcessed')}. Rows changed: ${count('rowsChanged')}. Cells changed: ${count('cellsChanged')}.`,
  `Companies processed: ${s.companyRowCountBefore ?? count('rowsProcessed')}. Companies preserved: ${s.companiesPreserved ?? s.companyRowCountAfter ?? s.companyRowCountBefore ?? 0}. Company rows deleted: ${s.companyRowsDeleted ?? 0}.`,
  `Contacts verified: ${count('contactsVerified')}. Existing contacts repaired: ${count('existingContactsRepaired','existingGroupsRepaired')}. New POCs added: ${count('newContactsAdded','newPeopleSelected')}.`,
  `Phone cells filled: ${count('phoneCellsFilled')}. Email cells filled: ${count('emailCellsFilled')}. Phone lookups pending: ${pending.filter(p=>p.kind==='phone').length}. Email lookups pending: ${pending.filter(p=>p.kind==='email').length}.`,
  result.indianPhoneGate?.enabled
    ? `Indian-number preference: ${result.indianPhoneGate.acceptedRows?.length||0} company rows have +91 POC evidence; ${result.indianPhoneGate.foreignFallbackRows?.length||0} use verified foreign phone fallback; ${result.indianPhoneGate.unresolvedRows?.length||0} remain contact-unresolved and were preserved; ${result.indianPhoneGate.pendingRows?.length||0} wait for exact Apollo callbacks. Company rows deleted: 0. POC scope 1-2; at most four distinct finalist attempts per POC.`
    : '',
  poc.join(' '),
  `Provider calls: Apollo ${calls.apollo??0}; LinkedIn ${calls.linkedin??0}; public search ${calls.publicSearch??0}; AI ${calls.ai??result.modelCalls??0}; Google Sheets ${calls.googleSheets??0}.`,
  s.haltError?errors.format(s.haltError):'',
  unique.length?compactIssues(unique):'',
 ].filter(Boolean).join('\n\n');
}
module.exports={
  build,
  compactIssues,
  groupIssues,
  rowSample,
  MAX_DIAGNOSTIC_GROUPS,
  MAX_SAMPLE_ROWS,
};
