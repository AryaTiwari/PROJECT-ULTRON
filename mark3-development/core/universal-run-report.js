'use strict';
const errors = require('./spreadsheet-enrichment-errors');
function build(result = {}) {
 const s=result.stats||{},m=result.metrics||{},gate=result.completionGate||{},pending=m.pending||[];
 const state=result.completionState||require('./universal-completion-state').decide(result);
 const issues=(gate.issues||[]).map(i=>({rowNumber:i.rowNumber,target:i.target,problem:i.message,explanation:i.detail||'The required evidence did not pass verification.',action:i.nextAction||'Provide additional verified evidence or retry the affected row.'}));
 for(const gap of gate.contactGaps||[]){const awaiting=pending.some(p=>Number(p.rowNumber)===Number(gap.rowNumber)&&Number(p.groupOrdinal)===Number(gap.groupOrdinal)&&p.kind===gap.field);
  issues.push({rowNumber:gap.rowNumber,target:'POC-'+gap.groupOrdinal,problem:awaiting?`Apollo ${gap.field} lookup is still pending.`:`Verified ${gap.field} is unavailable.`,explanation:awaiting?'The paid request has been saved with this exact contact owner.':'No safe contact value was returned for this person.',action:awaiting?'Allow callback recovery to finish; do not purchase the lookup again.':'Leave the field blank or provide a verified source.'});
 }
 for(const failure of s.rowFailureAudit||[]){const typed=errors.normalize(Object.assign(new Error(failure.message),failure));issues.push({rowNumber:failure.rowNumber,problem:typed.humanTitle,explanation:typed.humanExplanation,action:typed.hint});}
 const seen=new Set(),unique=issues.filter(i=>{const key=[i.rowNumber??'',i.target||'',i.problem||''].join('|');if(seen.has(key))return false;seen.add(key);return true;});
 const poc=(result.schema?.personGroups||[]).map(g=>{const missing=(gate.requiredIdentityIssues||[]).filter(i=>i.groupOrdinal===g.ordinal).length;const contacts=(gate.contactGaps||[]).filter(i=>i.groupOrdinal===g.ordinal).length;return `POC-${g.ordinal}: ${missing?missing+' unresolved identities':'identities present'}${contacts?', '+contacts+' missing contact fields':''}.`;});
 const count=(field,fallback)=>m[field]??s[fallback||field]??0;
 const calls=m.providerCalls||{};
 return [
  `${result.sheetName||'Worksheet'} — ${state}`,
  result.validationMode||result.rowLimitApplied?`Validation mode: up to ${result.rowLimitApplied} rows.`:'Full-sheet mode.',
  `Rows processed: ${count('rowsProcessed')}. Rows changed: ${count('rowsChanged')}. Cells changed: ${count('cellsChanged')}.`,
  `Contacts verified: ${count('contactsVerified')}. Existing contacts repaired: ${count('existingContactsRepaired','existingGroupsRepaired')}. New POCs added: ${count('newContactsAdded','newPeopleSelected')}.`,
  `Phone cells filled: ${count('phoneCellsFilled')}. Email cells filled: ${count('emailCellsFilled')}. Phone lookups pending: ${pending.filter(p=>p.kind==='phone').length}. Email lookups pending: ${pending.filter(p=>p.kind==='email').length}.`,
  result.indianPhoneGate?.enabled
    ? `Indian-number gate: ${result.indianPhoneGate.acceptedRows?.length||0} companies accepted with +91 evidence; ${result.indianPhoneGate.rejectedRows?.length||0} rejected and ${result.indianPhoneGate.clearedRows||0} cleared; ${result.indianPhoneGate.pendingRows?.length||0} waiting for exact Apollo callbacks. POC scope 1-2; phone-reveal shortlist: two primary decision-makers plus at most one POC-2 fallback.`
    : '',
  poc.join(' '),
  `Provider calls: Apollo ${calls.apollo??0}; LinkedIn ${calls.linkedin??0}; public search ${calls.publicSearch??0}; AI ${calls.ai??result.modelCalls??0}; Google Sheets ${calls.googleSheets??0}.`,
  s.haltError?errors.format(s.haltError):'',
  unique.length?'Unresolved rows:\n'+unique.map(i=>`- Row ${i.rowNumber??'unknown'}${i.target?', '+i.target:''}: Problem: ${i.problem} Explanation: ${i.explanation} What to do: ${i.action}`).join('\n'):'',
 ].filter(Boolean).join('\n\n');
}
module.exports={build};
