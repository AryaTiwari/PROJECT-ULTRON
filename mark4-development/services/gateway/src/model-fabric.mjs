import { modelMetrics, modelRouteStates } from "./db.mjs";
const env = name => String(process.env[name] || "").trim();

const routes = [
  { id:"cognition-primary", role:"cognition", provider:env("ULTRON_M4_COGNITION_PROVIDER"), model:env("ULTRON_M4_COGNITION_MODEL"), baseScore:100 },
  { id:"worker-fast", role:"worker", provider:env("ULTRON_M4_WORKER_PROVIDER"), model:env("ULTRON_M4_WORKER_MODEL"), baseScore:94 },
  { id:"verifier-independent", role:"verifier", provider:env("ULTRON_M4_VERIFIER_PROVIDER"), model:env("ULTRON_M4_VERIFIER_MODEL"), baseScore:96 },
  { id:"creative", role:"creative", provider:env("ULTRON_M4_CREATIVE_PROVIDER"), model:env("ULTRON_M4_CREATIVE_MODEL"), baseScore:92 },
  { id:"hermes-default", role:"*", provider:"", model:"", baseScore:80 },
];

function configured(route) {
  return route.id === "hermes-default" || Boolean(route.provider && route.model);
}
function isCooling(state) {
  return Boolean(state?.cooldownUntil && Date.parse(state.cooldownUntil) > Date.now());
}
function score(route, metric, state) {
  if (isCooling(state)) return -Infinity;
  let value = route.baseScore;
  if (metric?.calls) {
    const success = metric.successes / metric.calls;
    value += success * 14;
    value -= Math.min(12, Number(metric.averageLatencyMs || 0) / 1200);
  }
  value -= Math.min(18, Number(state?.consecutiveFailures || 0) * 6);
  return value;
}
function maps() {
  return {
    metrics:new Map(modelMetrics().map(m=>[m.routeId,m])),
    states:new Map(modelRouteStates().map(s=>[s.routeId,s]))
  };
}
export function rankModels(role="cognition", exclude=[]) {
  const {metrics,states}=maps(), blocked=new Set(exclude);
  return routes.filter(r=>!blocked.has(r.id)&&(r.role===role||r.role==="*")&&configured(r))
    .map(r=>({...r,state:states.get(r.id)||null,score:score(r,metrics.get(r.id),states.get(r.id))}))
    .filter(r=>Number.isFinite(r.score))
    .sort((a,b)=>b.score-a.score);
}
export function chooseModel(role="cognition", exclude=[]) {
  return rankModels(role,exclude)[0] || routes.find(r=>r.id==="hermes-default");
}
export function classifyModelError(error) {
  const status=Number(error?.status||0),message=String(error?.message||"").toLowerCase();
  if(status===401||status===403||/api.?key|credential|unauthorized|forbidden/.test(message))
    return {errorClass:"auth",cooldownMs:60*60*1000};
  if(status===429||/rate.?limit|quota|too many requests/.test(message))
    return {errorClass:"rate_limit",cooldownMs:10*60*1000};
  if(status>=500||/timeout|temporar|overload|unavailable|connection/.test(message))
    return {errorClass:"provider",cooldownMs:3*60*1000};
  return {errorClass:"request",cooldownMs:60*1000};
}
export function fabricStatus() {
  const {metrics,states}=maps();
  return routes.map(r=>{
    const state=states.get(r.id)||null;
    return {id:r.id,role:r.role,configured:configured(r),provider:r.provider||null,model:r.model||null,
      cooling:isCooling(state),score:Number.isFinite(score(r,metrics.get(r.id),state))?Number(score(r,metrics.get(r.id),state).toFixed(2)):null,
      metrics:metrics.get(r.id)||null,state};
  });
}
