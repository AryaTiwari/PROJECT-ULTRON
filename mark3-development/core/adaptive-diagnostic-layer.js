'use strict';

const recovery=require('./universal-enrichment-recovery');
const errors=require('./spreadsheet-enrichment-errors');

const journal=[];
const MAX_JOURNAL=50;

function text(value){return String(value==null?'':value).trim();}
function record(entry){journal.push({...entry,at:new Date().toISOString()});while(journal.length>MAX_JOURNAL)journal.shift();return journal.at(-1);}
function recent(limit=10){return journal.slice(-Math.max(1,Math.min(50,Number(limit)||10))).map(item=>({...item}));}

function questionFor(typed,context={}){
  const code=text(typed.code).toUpperCase();
  if(/SCHEMA|CONFIDENCE|AMBIGUOUS/.test(code)||typed.subsystem==='SCHEMA'){
    return 'I cannot prove the worksheet ownership/schema safely. Which columns should be treated as the source anchor and which columns are the writable POC fields?';
  }
  if(/TAB_NOT_FOUND|TARGET/.test(code)||typed.subsystem==='TARGETING'){
    return 'I could not prove the requested worksheet target. Which exact worksheet/tab should I use?';
  }
  if(/WRITE_SCOPE|LIVE_CONFLICT|IDENTITY_UNVERIFIED/.test(code)){
    return 'The planned write conflicts with the current safety contract or live row. Should I re-inspect and re-plan only the affected row, or leave it untouched?';
  }
  if(typed.type==='AUTH'||typed.type==='PERMISSION'){
    return 'The required provider authorization is unavailable. Re-authorize that provider, then retry the same mission.';
  }
  return null;
}

function assess(error={},context={}){
  const typed=errors.normalize(error,{stage:error?.stage||context.stage||'diagnostic'});
  const classified=recovery.classify(error,{stage:typed.stage});
  const preApproval=!context.approvalReentry&&!context.paidExecution;
  const safeReadStage=/metadata|inspection|preapproval|target|schema|read/i.test(text(typed.stage));
  const autoRetry=Boolean(preApproval&&safeReadStage&&['NETWORK','TIMEOUT'].includes(typed.type));
  const safeAction=autoRetry?'retry_safe_read':classified.safeToRepair?(
    typed.type==='RATE_LIMIT'||typed.type==='COOLDOWN'?'wait_cooldown':
    typed.type==='NETWORK'||typed.type==='TIMEOUT'?'retry_idempotent_request':null
  ):null;
  const question=autoRetry?null:questionFor(typed,context);
  const diagnosis={
    code:typed.code,subsystem:typed.subsystem,type:typed.type,stage:typed.stage,
    retryable:Boolean(classified.retryable),safeToRepair:Boolean(classified.safeToRepair),
    autoRetry,safeAction,userActionRequired:Boolean(question),question,
    recommendation:typed.hint||classified.recommendedAction||null,
    nextEligibleAt:error?.nextEligibleAt||classified.nextEligibleAt||null,
  };
  record({route:context.route||null,...diagnosis});
  return diagnosis;
}

async function attemptSafeRetry(diagnosis,fn){
  if(!diagnosis?.autoRetry||!diagnosis.safeAction||typeof fn!=='function')return null;
  recovery.assert(diagnosis.safeAction);
  try{return await fn();}catch(error){assess(error,{route:'diagnostic-retry',stage:error?.stage||'diagnostic-retry'});throw error;}
}

function summary(){
  const rows=recent(10);
  return {
    status:rows.some(item=>item.userActionRequired)?'attention':rows.some(item=>item.retryable)?'recoverable':'healthy',
    recent:rows,
    safety:{automaticActions:[...recovery.SAFE],forbiddenActions:[...recovery.FORBIDDEN]},
  };
}

module.exports={assess,attemptSafeRetry,recent,summary,questionFor};
