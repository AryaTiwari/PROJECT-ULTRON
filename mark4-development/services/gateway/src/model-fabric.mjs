import { modelMetrics } from "./db.mjs";
const env = name => String(process.env[name] || "").trim();

const routes = [
  { id:"cognition-primary", role:"cognition", provider:env("ULTRON_M4_COGNITION_PROVIDER"), model:env("ULTRON_M4_COGNITION_MODEL"), baseScore:100 },
  { id:"worker-fast", role:"worker", provider:env("ULTRON_M4_WORKER_PROVIDER"), model:env("ULTRON_M4_WORKER_MODEL"), baseScore:94 },
  { id:"verifier-independent", role:"verifier", provider:env("ULTRON_M4_VERIFIER_PROVIDER"), model:env("ULTRON_M4_VERIFIER_MODEL"), baseScore:96 },
  { id:"creative", role:"creative", provider:env("ULTRON_M4_CREATIVE_PROVIDER"), model:env("ULTRON_M4_CREATIVE_MODEL"), baseScore:92 },
  { id:"hermes-default", role:"*", provider:"", model:"", baseScore:80 },
];
function score(route, metric) {
  if (!metric || !metric.calls) return route.baseScore;
  const success=metric.successes/metric.calls;
  const latencyPenalty=Math.min(12,Number(metric.averageLatencyMs||0)/1200);
  return route.baseScore+success*14-latencyPenalty;
}
export function chooseModel(role="cognition") {
  const metrics=new Map(modelMetrics().map(m=>[m.routeId,m]));
  return routes.filter(r=>(r.role===role||r.role==="*")&&(r.id==="hermes-default"||(r.provider&&r.model)))
    .map(r=>({...r,score:score(r,metrics.get(r.id))})).sort((a,b)=>b.score-a.score)[0] || routes.at(-1);
}
export function fabricStatus() {
  const metrics=new Map(modelMetrics().map(m=>[m.routeId,m]));
  return routes.map(r=>({id:r.id,role:r.role,configured:r.id==="hermes-default"||Boolean(r.provider&&r.model),
    provider:r.provider||null,model:r.model||null,score:Number(score(r,metrics.get(r.id)).toFixed(2)),metrics:metrics.get(r.id)||null}));
}
