// Provider/model-family diverse OmniRoute-only reasoning for the heavy 3-POC workflow.
// A gateway route label is not treated as diversity when the returned concrete
// model belongs to another model family. Example: vertex/* resolving to a Gemini
// model is recorded as a route-family mismatch, then the next route is tried.

const omniRoute = require('../../core/omniroute');
const registry = require('./provider-registry');
const modelRouter = require('./model-router');
const threePoc = require('./three-poc-enrichment-operator');
const { emit } = require('./events');

const INSTALL_FLAG = Symbol.for('ultron.mark3.threePocOmniRouteDiversity.installed');
const laneCursor = new Map();
let runState = freshState();

function freshState() {
  return {
    calls: 0,
    concreteAttempts: 0,
    concreteSuccesses: 0,
    aliasFallbacks: 0,
    failures: 0,
    routeFamilyMismatches: 0,
    routeFamilyMismatchCounts: {},
    requestedProviderCounts: {},
    providerCounts: {},
    modelCounts: {},
    catalogModels: 0,
    providerPool: [],
    effectiveProviderPool: [],
  };
}
function csv(name,fallback='') { return String(process.env[name] || fallback).split(',').map((v)=>v.trim().toLowerCase()).filter(Boolean); }
function providerOrder() { return csv('ULTRON_M3_THREE_POC_OMNI_PROVIDERS','gemini,anthropic,deepseek,qwen,mistral,openai,xai,groq,vertex,zenmux,nvidia,pollinations'); }
function provider(model) { return registry.providerFromModel(String(model || '').trim()); }
function usableConcreteModel(model) {
  const value = String(model || '').trim();
  if (!value || /^auto(?:\/|$)/i.test(value) || /^no-think(?:\/|$)/i.test(value)) return false;
  if (registry.isBlockedModel(value) || registry.isNonChatModel(value)) return false;
  const p = provider(value); return p && p !== 'unknown' && registry.policyAllows(p);
}
function researchScore(model,taskType='research') {
  const value=String(model||'').toLowerCase(); const task=String(taskType||'research').toLowerCase(); let score=0;
  if (/latest|stable/.test(value)) score+=8;
  if (/reason|think|pro|sonnet|opus|r1|large/.test(value)) score+=28;
  if (/gpt[-_/]?5|o3|o4/.test(value)) score+=32;
  if (/gemini[-_/]?3\.(?:5|6)|gemini[-_/]?3/.test(value)) score+=34;
  if (/claude[-_/]?(?:4|opus|sonnet)/.test(value)) score+=34;
  if (/deepseek[-_/]?(?:r1|v3)/.test(value)) score+=28;
  if (/qwen[-_/]?3/.test(value)) score+=24;
  if (/grok[-_/]?(?:4|3)/.test(value)) score+=22;
  if (/mistral.*large/.test(value)) score+=22;
  if (/flash/.test(value)) score+=8;
  if (/mini|lite|small|nano/.test(value)) score-=['research','planning'].includes(task)?12:2;
  if (/coder|coding|code[-_/]/.test(value) && task!=='coding') score-=10;
  if (/preview|experimental|\bexp\b/.test(value)) score-=5;
  if (/deprecated|legacy|retired|eol/.test(value)) score-=100;
  return score;
}
function laneFrom(messages=[]) {
  const system=String(messages.find((m)=>m?.role==='system')?.content||'').toLowerCase();
  if (system.includes('hiring-authority selector')) return 'selector';
  if (system.includes('independent hiring-responsibility reviewer')) return 'reviewer';
  if (system.includes('exact linkedin employer resolver')) return 'employer';
  if (system.includes('company context analyst')) return 'company-context';
  if (system.includes('profile employer normalizer')) return 'profile-normalizer';
  return 'three-poc-general';
}
function rotate(items,offset) { if(!items.length)return[]; const start=((offset%items.length)+items.length)%items.length; return [...items.slice(start),...items.slice(0,start)]; }
function laneOffset(lane) { return Number(({selector:0,reviewer:1,employer:2,'company-context':3,'profile-normalizer':4})[lane] ?? 0); }
function increment(target,key) { if(key) target[key]=Number(target[key]||0)+1; }
function routeFamilyMatches(candidateProvider, actualModel) {
  const actual = provider(actualModel);
  if (!candidateProvider || !actual || actual === 'unknown') return false;
  // Aggregator/transport labels do not prove model-family diversity. They are
  // accepted only when the concrete returned model retains that provider family.
  return actual === candidateProvider;
}

async function diversePool(taskType='research') {
  let models=[]; try { models=await omniRoute.listModels({force:false}); } catch {}
  const concrete=[...new Set(models.map(String).map((v)=>v.trim()).filter(usableConcreteModel))]; runState.catalogModels=concrete.length;
  const grouped=new Map();
  for(const model of concrete){const p=provider(model); if(!grouped.has(p))grouped.set(p,[]); grouped.get(p).push(model);}
  const order=providerOrder(); const remaining=[...grouped.keys()].filter((p)=>!order.includes(p)).sort();
  const providers=[...order,...remaining].filter((p)=>grouped.has(p)); const pool=[];
  for(const p of providers){const best=[...grouped.get(p)].sort((a,b)=>researchScore(b,taskType)-researchScore(a,taskType)||a.localeCompare(b))[0]; if(best)pool.push({provider:p,model:best});}
  runState.providerPool=pool.map((item)=>item.provider); return pool;
}

async function diversifiedChat(originalChat,{messages,model='auto/best-reasoning',tools=null,taskType='research'}={}) {
  require('./command-control-plane').assertAllowed('general-model',{messages}); runState.calls++;
  const lane=laneFrom(messages); const pool=await diversePool(taskType);
  if(!pool.length){runState.aliasFallbacks++; return originalChat({messages,model,tools,taskType});}
  const cursor=Number(laneCursor.get(lane)||0); laneCursor.set(lane,cursor+1);
  const ordered=rotate(pool,laneOffset(lane)+cursor);
  const maxModels=Math.max(1,Math.min(8,Number(process.env.ULTRON_M3_THREE_POC_OMNI_ATTEMPTS||5)));
  const timeoutMs=Math.max(10000,Number(process.env.ULTRON_M3_THREE_POC_OMNI_TIMEOUT_MS||50000)); let lastError=null;

  for(const candidate of ordered.slice(0,maxModels)){
    runState.concreteAttempts++; increment(runState.requestedProviderCounts,candidate.provider); const started=Date.now();
    emit('model_candidate_started',{model:candidate.model,provider:candidate.provider,candidateNumber:runState.concreteAttempts,timeoutMs,nativeRouting:true,omniRouteOnly:true,diversified:true,lane});
    try {
      const result=await omniRoute.chat({messages,model:candidate.model,tools,taskType,timeoutMs,maxAttempts:1,skipModelValidation:true});
      const actualModel=String(result?.raw?.model||result?.model||candidate.model).trim(); const actualProvider=provider(actualModel);
      if(!usableConcreteModel(actualModel)) throw new Error(`OmniRoute diversified reasoning returned an ineligible model: ${actualModel}`);
      if(!routeFamilyMatches(candidate.provider,actualModel)){
        runState.routeFamilyMismatches++; increment(runState.routeFamilyMismatchCounts,`${candidate.provider}->${actualProvider||'unknown'}`);
        emit('model_candidate_failed',{model:candidate.model,provider:candidate.provider,actualModel,actualProvider,kind:'ROUTE_FAMILY_MISMATCH',message:`Requested ${candidate.provider} route resolved to ${actualModel}`,durationMs:Date.now()-started,nativeRouting:true,omniRouteOnly:true,diversified:true,lane});
        continue;
      }
      runState.concreteSuccesses++; increment(runState.providerCounts,actualProvider); increment(runState.modelCounts,actualModel);
      if(!runState.effectiveProviderPool.includes(actualProvider)) runState.effectiveProviderPool.push(actualProvider);
      registry.recordSuccess(actualModel);
      emit('model_candidate_succeeded',{model:actualModel,provider:actualProvider,durationMs:Date.now()-started,nativeRouting:true,omniRouteOnly:true,diversified:true,lane});
      return {...result,model:actualModel,provider:actualProvider,transport:'omniroute',routingMode:'omniroute-only',personalApiFallbackAllowed:false,diversifiedOmniRoute:true,reasoningLane:lane};
    } catch(error){
      lastError=error; runState.failures++;
      emit('model_candidate_failed',{model:candidate.model,provider:candidate.provider,message:String(error?.message||error).slice(0,500),durationMs:Date.now()-started,nativeRouting:true,omniRouteOnly:true,diversified:true,lane});
      registry.recordFailure(candidate.model,'UPSTREAM',error?.message||String(error));
    }
  }
  runState.aliasFallbacks++;
  try{return await originalChat({messages,model,tools,taskType});}
  catch(error){if(lastError&&!error.cause)error.cause=lastError; throw error;}
}
function startRun(){runState=freshState();return stats();}
function stats(){return {...runState,routeFamilyMismatchCounts:{...runState.routeFamilyMismatchCounts},requestedProviderCounts:{...runState.requestedProviderCounts},providerCounts:{...runState.providerCounts},modelCounts:{...runState.modelCounts},providerPool:[...runState.providerPool],effectiveProviderPool:[...runState.effectiveProviderPool],personalApiFallbacks:0};}
function install(){
  if(globalThis[INSTALL_FLAG])return globalThis[INSTALL_FLAG];
  const originalEnrichWorkbook=threePoc.enrichWorkbook.bind(threePoc); const originalFormatResult=threePoc.formatResult.bind(threePoc);
  threePoc.enrichWorkbook=async function diverseOmniRouteThreePocRun(...args){startRun();const previous=modelRouter.chatOmniRouteOnly;const boundOriginal=previous.bind(modelRouter);modelRouter.chatOmniRouteOnly=(request={})=>diversifiedChat(boundOriginal,request);try{const result=await originalEnrichWorkbook(...args);return{...result,omniRouteDiversity:stats()};}finally{modelRouter.chatOmniRouteOnly=previous;}};
  threePoc.formatResult=function diversityFormatResult(result){
    const base=originalFormatResult(result);const s=result?.omniRouteDiversity;if(!s)return base;
    const providers=Object.entries(s.providerCounts||{}).map(([n,c])=>`${n}:${c}`).join(', ')||'none';
    const mismatches=Object.entries(s.routeFamilyMismatchCounts||{}).map(([n,c])=>`${n}:${c}`).join(', ')||'none';
    const models=Object.entries(s.modelCounts||{}).map(([n,c])=>`${n}:${c}`).join(', ')||'none';
    const pool=(s.providerPool||[]).join(', ')||'none'; const effective=(s.effectiveProviderPool||[]).join(', ')||'none';
    return `${base} OmniRoute diversity: ${s.concreteSuccesses}/${s.calls} genuine concrete-family reasoning calls completed (${s.concreteAttempts} concrete attempts, ${s.aliasFallbacks} alias fallbacks); genuine families used [${providers}]; concrete models [${models}]; advertised route pool [${pool}]; effective family pool [${effective}]; route-family mismatches ${s.routeFamilyMismatches} [${mismatches}]. Personal-API fallbacks: 0.`;
  };
  const api=Object.freeze({startRun,stats,diversePool,researchScore,laneFrom,usableConcreteModel,routeFamilyMatches});globalThis[INSTALL_FLAG]=api;return api;
}
module.exports={install,startRun,stats,diversePool,researchScore,laneFrom,usableConcreteModel,routeFamilyMatches};
