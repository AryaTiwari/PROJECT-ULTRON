'use strict';
function decide(result){
 const gate=result.completionGate||{},metrics=result.metrics||{},s=result.stats||{};
 const gaps=gate.contactGaps||[],identities=gate.requiredIdentityIssues||[];
 const errors=[s.haltError,...(s.rowFailureAudit||[]),...(result.aiBatchRescue?.errors||[]),result.bigPickleFallback?.haltError].filter(Boolean);
 const unresolved=gate.complete===false||gaps.length>0;
 if(gate.status==='AUDIT_FAILED'||result.postPrimaryError)return 'PARTIAL_PROVIDER_UNAVAILABLE';
 if(unresolved||s.haltedEarly){
   if(errors.some(e=>e.type==='RATE_LIMIT'||e.errorType==='RATE_LIMIT'||e.status===429))return 'PARTIAL_PROVIDER_LIMIT';
   if(s.haltedEarly||errors.some(e=>['NETWORK','TIMEOUT','AUTH','PERMISSION','CONFIG','API'].includes(e.type||e.errorType)))return 'PARTIAL_PROVIDER_UNAVAILABLE';
   const pending=metrics.pending||[];
   if(!identities.length&&gate.complete!==false&&gaps.length&&gaps.every(g=>pending.some(p=>Number(p.rowNumber)===Number(g.rowNumber)&&Number(p.groupOrdinal)===Number(g.groupOrdinal)&&p.kind===g.field)))return 'COMPLETE_WITH_PENDING_CONTACTS';
   return 'TERMINAL_DATA_EXHAUSTED';
 }
 return 'COMPLETE';
}
module.exports={decide};
