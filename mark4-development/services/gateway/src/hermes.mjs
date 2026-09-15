import { config } from "./config.mjs";
function headers(extra={}) {
  if(!config.hermesKey) throw new Error("ULTRON_M4_HERMES_API_KEY is not configured.");
  return {Authorization:`Bearer ${config.hermesKey}`,"Content-Type":"application/json",...extra};
}
async function request(pathname,options={}) {
  const response=await fetch(`${config.hermesUrl}${pathname}`,{...options,headers:headers(options.headers||{})});
  const text=await response.text(); let data=null;
  try{data=text?JSON.parse(text):null;}catch{data={raw:text};}
  if(!response.ok){const error=new Error(data?.detail||data?.error||data?.message||`Hermes HTTP ${response.status}`);error.status=response.status;error.data=data;throw error;}
  return data;
}
export const hermes={
  health:async()=>{try{const r=await fetch(`${config.hermesUrl}/health`);return{ok:r.ok,status:r.status,data:await r.json().catch(()=>null)};}catch(error){return{ok:false,error:error.message};}},
  capabilities:()=>request("/v1/capabilities"),
  skills:()=>request("/v1/skills"),
  toolsets:()=>request("/v1/toolsets"),
  sessions:(query="")=>request(`/api/sessions${query?`?${query}`:""}`),
  createSession:(value={})=>request("/api/sessions",{method:"POST",body:JSON.stringify(value)}),
  messages:id=>request(`/api/sessions/${encodeURIComponent(id)}/messages`),
  fork:(id,value={})=>request(`/api/sessions/${encodeURIComponent(id)}/fork`,{method:"POST",body:JSON.stringify(value)}),
  createRun:(value={})=>request("/v1/runs",{method:"POST",body:JSON.stringify(value)}),
  runStatus:runId=>request(`/v1/runs/${encodeURIComponent(runId)}`),
  approval:(runId,value)=>request(`/v1/runs/${encodeURIComponent(runId)}/approval`,{method:"POST",body:JSON.stringify(value)}),
  stopRun:runId=>request(`/v1/runs/${encodeURIComponent(runId)}/stop`,{method:"POST",body:"{}"}),
  runEvents:async(runId,signal)=>{
    const response=await fetch(`${config.hermesUrl}/v1/runs/${encodeURIComponent(runId)}/events`,{
      method:"GET",headers:headers({Accept:"text/event-stream"}),signal
    });
    if(!response.ok||!response.body){const text=await response.text();throw new Error(`Hermes run events HTTP ${response.status}: ${text.slice(0,500)}`);}
    return response;
  },
  streamChat:async(id,value,signal)=>{
    const response=await fetch(`${config.hermesUrl}/api/sessions/${encodeURIComponent(id)}/chat/stream`,{
      method:"POST",headers:headers(),body:JSON.stringify(value),signal
    });
    if(!response.ok||!response.body){const text=await response.text();throw new Error(`Hermes stream HTTP ${response.status}: ${text.slice(0,500)}`);}
    return response;
  }
};
