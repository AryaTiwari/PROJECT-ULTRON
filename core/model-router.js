const { config } = require('./config');
const direct = require('./direct-model-router');
const openCode = require('./opencode-router');
const omniRoute = require('./omniroute');

function isOmniRouteModel(model){return String(model||'').trim().toLowerCase().startsWith('omniroute/');}
function qualitySensitiveTask(taskType){return ['coding','research','planning'].includes(String(taskType||'').toLowerCase());}
async function chat({messages,model,tools=null,taskType='general'}={}){
  if(!Array.isArray(messages)||!messages.length)throw new Error('Model request requires messages.');
  const requestedModel=model||config.router.model; const mode=String(process.env.ULTRON_MODEL_PROVIDER||'omniroute').toLowerCase();
  if(isOmniRouteModel(requestedModel))return omniRoute.chat({messages,model:requestedModel,taskType,tools});
  if(mode==='omniroute')return omniRoute.chat({messages,model:requestedModel,taskType,tools});
  if(mode==='opencode-server'||mode==='opencode')return openCode.chat({messages,model:requestedModel,tools});
  if(mode==='direct')return direct.directChat({messages,model:requestedModel,tools});
  if(mode==='auto'){
    try{return await omniRoute.chat({messages,model:requestedModel,taskType,tools});}catch(omniError){try{return await openCode.chat({messages,model:requestedModel,tools});}catch(openCodeError){try{return await direct.directChat({messages,model:requestedModel,tools});}catch(directError){throw new Error(`OmniRoute, OpenCode and direct routing all failed. OmniRoute: ${omniError.message}. OpenCode: ${openCodeError.message}. Direct: ${directError.message}`);}}}}
  throw new Error('No model provider mode is configured. Use omniroute (default), opencode-server, direct, or auto.');
}

async function streamChat({messages,model,tools=null,taskType='general',onDelta}={}){
  if(typeof onDelta!=='function')throw new Error('Streaming requires an onDelta callback.');
  const requestedModel=model||config.router.model; const mode=String(process.env.ULTRON_MODEL_PROVIDER||'omniroute').toLowerCase();
  if(isOmniRouteModel(requestedModel)||mode==='omniroute'||mode==='auto'){
    try{
      return await omniRoute.streamChat({
        messages,model:requestedModel,taskType,tools,
        onDelta,
        firstTokenTimeoutMs: qualitySensitiveTask(taskType)
          ? Number(process.env.ULTRON_STREAM_FIRST_TOKEN_TIMEOUT_COMPLEX_MS || 12000)
          : Number(process.env.ULTRON_STREAM_FIRST_TOKEN_TIMEOUT_MS || 5000),
      });
    }catch(error){
      if(mode!=='auto')throw error;
      const fallback=await chat({messages,model:requestedModel,tools,taskType});
      onDelta(fallback.content,{model:fallback.model,finishReason:'stop',fallback:true});
      return fallback;
    }
  }
  const result=await chat({messages,model:requestedModel,tools,taskType});
  onDelta(result.content,{model:result.model,finishReason:'stop',fallback:true});
  return result;
}

async function health(){const omni=await omniRoute.health();const openCodeHealth=await openCode.health();const directHealth=await direct.health();return{ok:omni.ok||openCodeHealth.ok||directHealth.anyConfigured,mode:omni.ok?'omniroute':openCodeHealth.ok?'opencode-server':directHealth.anyConfigured?'direct':'none',omniroute:omni,opencode:openCodeHealth,direct:directHealth};}
module.exports={chat,streamChat,health,isOmniRouteModel,chatViaOmniRoute:omniRoute.chat};
