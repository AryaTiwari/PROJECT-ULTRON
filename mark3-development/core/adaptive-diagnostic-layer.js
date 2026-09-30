'use strict';

const recovery=require('./universal-enrichment-recovery');
const errors=require('./spreadsheet-enrichment-errors');
const healer=require('./universal-enrichment-self-healer');

function text(value){return String(value==null?'':value).trim();}
function record(entry){return healer.recordDiagnosis(entry);}
function recent(limit=10){return healer.recent(limit).map(item=>({...item}));}

function questionFor(typed,context={}){
  const code=text(typed.code).toUpperCase();
  if(/SCHEMA|CONFIDENCE|AMBIGUOUS/.test(code)||typed.subsystem==='SCHEMA'){
    return 'I cannot prove the worksheet ownership/schema safely. Which columns should be treated as the source anchor and which columns are the writable POC fields?';
  }
  if(/TAB_NOT_FOUND|TARGET/.test(code)||typed.subsystem==='TARGETING'){
    const available=healer.cleanTabs(context.availableTabs||typed.original?.availableTabs);
    return available.length
      ? `I could not prove the requested worksheet target. Which exact worksheet/tab should I use? Available tabs: ${available.join(', ')}.`
      : 'I could not prove the requested worksheet target. Which exact worksheet/tab should I use?';
  }
  if(/WRITE_SCOPE|LIVE_CONFLICT|IDENTITY_UNVERIFIED/.test(code)){
    return 'The planned write conflicts with the current safety contract or live row. Should I re-inspect and re-plan only the affected row, or leave it untouched?';
  }
  if(typed.type==='AUTH'||typed.type==='PERMISSION'){
    return typed.subsystem==='GOOGLE_SHEETS'
      ? 'Google Sheets authorization needs attention. Complete the secure Google authorization opened by ULTRON, then retry the same mission.'
      : 'The required provider authorization is unavailable. Re-authorize that provider, then retry the same mission.';
  }
  return null;
}

function assess(error={},context={}){
  const typed=errors.normalize(error,{stage:error?.stage||context.stage||'diagnostic'});
  const classified=recovery.classify(error,{stage:typed.stage});
  const plan=healer.recoveryPlan(error,{...context,stage:typed.stage});
  const autoRetry=Boolean(plan.autoRetry);
  const safeAction=plan.safeAction||(classified.safeToRepair?(
    typed.type==='RATE_LIMIT'||typed.type==='COOLDOWN'?'wait_cooldown':
    typed.type==='NETWORK'||typed.type==='TIMEOUT'?'retry_idempotent_request':null
  ):null);
  const question=autoRetry?null:questionFor(typed,context);
  const diagnosis={
    code:typed.code,subsystem:typed.subsystem,type:typed.type,stage:typed.stage,
    retryable:Boolean(classified.retryable),safeToRepair:Boolean(classified.safeToRepair),
    autoRetry,safeAction,userActionRequired:Boolean(question),question,
    recommendation:typed.hint||classified.recommendedAction||null,
    nextEligibleAt:error?.nextEligibleAt||classified.nextEligibleAt||null,
    maxAttempts:plan.maxAttempts,backoffMs:plan.backoffMs,
    authRedirectRequired:plan.authRedirectRequired,
    worksheetDiagnostic:plan.worksheet,
    schemaDiagnostic:plan.schema,
  };
  record({route:context.route||null,sheetName:context.sheetName,spreadsheetId:context.spreadsheetId,
    availableTabs:context.availableTabs,attemptedRange:typed.attemptedRange,...diagnosis});
  return diagnosis;
}

async function attemptSafeRetry(diagnosis,fn){
  if(!diagnosis?.autoRetry||!diagnosis.safeAction||typeof fn!=='function')return null;
  recovery.assert(diagnosis.safeAction);
  const attempts=Math.max(1,Math.min(3,Number(diagnosis.maxAttempts||1)));
  let last=null;
  for(let attempt=1;attempt<attempts;attempt++){
    const delay=Number(diagnosis.backoffMs?.[attempt-1]||0);
    if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
    try{
      const result=await fn(attempt);
      if(result?.ok!==false){
        record({...diagnosis,healed:true,route:'diagnostic-retry'});
        return result;
      }
      last=Object.assign(new Error(result.errorMessage||result.text||result.errorCode||'Safe retry failed.'),{
        code:result.errorCode,subsystem:result.errorSubsystem,errorType:result.errorType,stage:result.errorStage,
      });
    }catch(error){last=error;}
  }
  if(last)assess(last,{route:'diagnostic-retry',stage:last?.stage||'diagnostic-retry',approvalReentry:true});
  return null;
}

function summary(){
  const rows=recent(10);
  return {
    status:rows.some(item=>item.userActionRequired)?'attention':rows.some(item=>item.retryable)?'recoverable':'healthy',
    recent:rows,
    benchmark:healer.benchmarkStatus(),
    safety:{automaticActions:[...recovery.SAFE],forbiddenActions:[...recovery.FORBIDDEN]},
  };
}

module.exports={assess,attemptSafeRetry,recent,summary,questionFor};
