const fs = require('fs');
const path = require('path');
const { UltronCore } = require('./ultron-core');
const { execute, openAITools, listTools } = require('./executor');

function extractUrl(text) { const match=String(text||'').match(/https?:\/\/[^\s]+/i); return match?match[0].replace(/[),.!?]+$/,''):null; }
function updateMood(message, result = null) { const text = String(message || '').toLowerCase(); let mood = 'CALM', intensity = 0.1; if (/\b(error|failed|broken|problem|urgent|emergency|danger|attack|threat)\b/.test(text)) { mood = 'ALERT'; intensity = 0.75; } else if (/\b(joke|funny|haha|lol|sarcasm|roast|stupid)\b/.test(text)) { mood = 'AMUSED'; intensity = 0.55; } else if (/\b(why|how|explain|analyze|compare|debug|architecture|design|plan|calculate)\b/.test(text) || String(result?.response || '').length > 1200) { mood = 'FOCUSED'; intensity = 0.45; } else if (/\b(wow|awesome|great|perfect|excellent|nice|love)\b/.test(text)) { mood = 'CONFIDENT'; intensity = 0.35; } const file = path.resolve(process.env.ULTRON_MOOD_FILE || '.ultron/mood.json'); try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ mood, intensity, updatedAt: new Date().toISOString() }, null, 2)); } catch {} return { mood, intensity }; }
function parseToolIntent(message){ const text=String(message||'').trim(); const normalized=text.replace(/^ultron\s*[,;:-]?\s*/i,''); if(/^speak(?:\s+out\s+loud|\s+this)?\s*[:,-]?\s+/i.test(normalized)) return {name:'speak_text',input:{text:normalized.replace(/^speak(?:\s+out\s+loud|\s+this)?\s*[:,-]?\s+/i,'').trim()}}; if(/^say\s+/i.test(normalized)) return {name:'speak_text',input:{text:normalized.replace(/^say\s+/i,'').trim()}}; if(/^(open|launch)\s+https?:\/\//i.test(normalized)) return {name:'open_url',input:{url:extractUrl(normalized)}}; if(/^(show|list)\s+(files|folders|directory|files in)/i.test(normalized)){const m=normalized.match(/(?:in|of|at)\s+(.+)$/i);return{name:'list_directory',input:{path:m?m[1].replace(/^['\"]|['\"]$/g,''):'.'}};} if(/^(what('?s| is) my (computer|pc) (spec|system|hardware)|system info|computer info)$/i.test(normalized))return{name:'system_info',input:{}}; if(/^read file\s+/i.test(normalized))return{name:'read_file',input:{path:normalized.replace(/^read file\s+/i,'').trim()}}; if(/^write file\s+/i.test(normalized)){try{return{name:'write_file',input:JSON.parse(normalized.replace(/^write file\s+/i,'').trim())}}catch{return null}} if(/^run powershell\s+/i.test(normalized))return{name:'run_powershell',input:{command:normalized.replace(/^run powershell\s+/i,'').trim()}}; return null; }
function parseLegacyToolMarkup(content){const text=String(content||'');const m=text.match(/<tool_call>[\s\S]*?<function=([^\s>]+)>[\s\S]*?<parameter=(\w+)>([\s\S]*?)<\/parameter>[\s\S]*?<\/tool_call>/i);return m?{name:m[1],input:{[m[2]]:m[3].trim()}}:null;}
function mergeToolCalls(toolCalls = []) { const merged = new Map(); for (const call of Array.isArray(toolCalls) ? toolCalls : []) { const index = call?.index ?? call?.id ?? String(merged.size); const existing = merged.get(index) || { index, id: call?.id || null, type: call?.type || 'function', function: { name: '', arguments: '' } }; if (call?.id) existing.id = call.id; if (call?.type) existing.type = call.type; if (call?.function?.name) existing.function.name += call.function.name; if (call?.function?.arguments) existing.function.arguments += call.function.arguments; merged.set(index, existing); } return [...merged.values()].map((call, i) => ({ id: call.id || `ultron-tool-${i}`, type: 'function', function: { name: call.function.name, arguments: call.function.arguments || '{}' } })); }
async function executeToolCalls(toolCalls, options = {}) { const results = []; for (const toolCall of mergeToolCalls(toolCalls)) { let input = {}; try { input = typeof toolCall.function.arguments === 'string' ? JSON.parse(toolCall.function.arguments || '{}') : (toolCall.function.arguments || {}); } catch { results.push({ toolCall, result: { ok: false, error: `Invalid tool arguments for ${toolCall.function.name}.` } }); continue; } const result = await execute(toolCall.function.name, input, { confirmed: options.confirmed === true, source: options.source || 'model' }); results.push({ toolCall, result }); } return results; }
function toolConversationMessages(toolResults) { return toolResults.map(({ toolCall, result }) => ({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) })); }
function toolSummary(toolResults) { return (toolResults || []).map(({ toolCall }) => toolCall?.function?.name).filter(Boolean); }
function usableText(value) { if (typeof value === 'string' && value.trim()) return value.trim(); if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : item?.text || item?.content || '').filter(Boolean).join('').trim(); if (value && typeof value === 'object') return String(value.text || value.content || value.value || '').trim(); return ''; }
class Mark2Runtime extends UltronCore{
  async handleMessage(message,options={}){
    const intent=parseToolIntent(message);
    if(intent){const risky=['run_powershell','write_file'].includes(intent.name);const guardian=require('./guardian').assess({message,action:risky?{destructive:true,requiresConfirmation:true}:null});const critic=require('./critic').analyze({message,plannedAction:risky?{destructive:true,externalSideEffect:true}:null},guardian);if(guardian.decision==='block'){updateMood(message,{response:'blocked'});return{ok:true,blocked:true,response:guardian.reasons.join(' '),guardian,critic};}if(guardian.decision==='warn'&&options.confirmed!==true){updateMood(message,{response:'warning'});return{ok:true,requires_confirmation:true,response:`Guardian warning: ${guardian.reasons.join(' ')}`,guardian,critic,tool:intent};}const result=await execute(intent.name,intent.input,{confirmed:options.confirmed===true,source:options.source||'core'});const mood=updateMood(message,result);return{ok:result.ok,response:result.ok?(intent.name==='speak_text'?'Voice synthesis completed.':`${intent.name} completed.`):result.error,tool_result:result,guardian,critic,mood};}
    const maxToolRounds=Number(process.env.ULTRON_MAX_TOOL_ROUNDS||4); let workingMessage=String(message||'').trim(); if(!workingMessage)return{ok:false,error:'Message is required.'};
    const base=this.buildMessages(workingMessage,await this.getRelevantMemories(workingMessage,8),require('./memory/local-store').getRecentMessages()); let messages=base; let lastResult=null; const tools=openAITools();
    for(let round=0; round<=maxToolRounds; round+=1){
      lastResult=await super.handleMessage(workingMessage,{...options,_messagesOverride:messages,_toolsOverride:tools});
      if(!lastResult?.toolCalls?.length) return lastResult;
      const toolResults=await executeToolCalls(lastResult.toolCalls,options);
      messages=[...messages,{role:'assistant',content:lastResult.response||null,tool_calls:mergeToolCalls(lastResult.toolCalls)},...toolConversationMessages(toolResults)];
      workingMessage='Continue from the tool results and answer the user directly.';
    }
    return {...lastResult,tool_loop_exhausted:true};
  }

  async handleMessageStream(message, options={}, onEvent=()=>{}) {
    const intent=parseToolIntent(message); if(intent){ const result=await this.handleMessage(message,options); onEvent({type:'final',state:'complete',label:'Task complete.',result}); return; }
    const userMessage=String(message||'').trim(); if(!userMessage) { onEvent({type:'error',state:'error',error:'Message is required.'}); return; }
    const task=require('./task-classifier').classify(userMessage); const selectedModel=require('./model-policy').selectModel(userMessage,options.model); const guardian=require('./guardian').assess({message:userMessage,action:options.action||null}); const critic=require('./critic').analyze({message:userMessage,plannedAction:options.action||null},guardian);
    onEvent({type:'meta',state:'thinking',label:'Evaluating command parameters…',task,model:selectedModel,guardian,critic});
    if(guardian.decision==='block'||(guardian.decision==='warn'&&options.confirmed!==true)||(critic.status==='blocked')){ const result={ok:true,response:guardian.decision==='block'?`I can't execute that request. ${guardian.reasons.join(' ')}`:guardian.decision==='warn'?`Guardian warning: ${guardian.reasons.join(' ')}`:'The request needs a safer approach before execution.', requires_confirmation:guardian.decision!=='block', guardian,critic,task,model:selectedModel}; onEvent({type:'final',state:'complete',label:'Task complete.',result}); return; }
    onEvent({type:'meta',state:'planning',label:`Planning a ${task.taskType || 'general'} response.`});
    const memoryResults=[]; for(const candidate of require('./ultron-core').extractMemoryCandidates(userMessage)) memoryResults.push(await this.rememberCandidate(candidate));
    if(memoryResults.length) onEvent({type:'meta',state:'researching',label:'Checking relevant memory context.',memory:memoryResults});
    const relevantMemories=await this.getRelevantMemories(userMessage,8); const recent=require('./memory/local-store').getRecentMessages(); let messages=this.buildMessages(userMessage,relevantMemories,recent); const router=require('./model-router'); const tools=openAITools(); onEvent({type:'meta',state:'researching',label:task.taskType==='research'?'Researching available context.':'Inspecting relevant context.',task,model:selectedModel,memory:memoryResults,relevant_memories:relevantMemories});
    const maxToolRounds=Number(process.env.ULTRON_MAX_TOOL_ROUNDS||4); const started=Date.now(); let full=''; let finalResult=null;
    for(let round=0; round<=maxToolRounds; round+=1){
      full=''; let streamResult;
      try { streamResult=await router.streamChat({messages,model:selectedModel,taskType:task.taskType,tools,onDelta:(text,meta)=>{full+=text;onEvent({type:'delta',state:'responding',text,...meta});}}); }
      catch(error){ await require('./telemetry').recordModelResult({model:selectedModel,taskType:task.taskType,success:false,latencyMs:Date.now()-started,errorType:error?.name||'model_error',metadata:{message:String(error?.message||error).slice(0,500),streamedChars:full.length}}); onEvent({type:'error',state:'error',label:'ULTRON request failed.',error:error.message,status:error.status||null,partial:Boolean(full)}); return; }
      const toolCalls=mergeToolCalls(streamResult.toolCalls);
      const streamText=usableText(streamResult?.content || streamResult?.response || streamResult?.text || full);
      if(!toolCalls.length && streamText){ onEvent({type:'meta',state:'synthesizing',label:'Synthesizing final response.'}); finalResult={ok:true,response:streamText,model:streamResult.model,task,guardian,critic,memory:memoryResults,relevant_memories:relevantMemories,tools:listTools()}; break; }
      if(!toolCalls.length && !streamText){
        onEvent({type:'meta',state:'synthesizing',label:'Stream returned no usable text. Recovering through the standard execution path.'});
        try {
          const fallback=await this.handleMessage(userMessage,options);
          const fallbackText=usableText(fallback?.response || fallback?.text || fallback?.content);
          if(fallbackText){ finalResult={...fallback,response:fallbackText,text:fallbackText,model:fallback.model || streamResult?.model,task:fallback.task || task,guardian:fallback.guardian || guardian,critic:fallback.critic || critic}; onEvent({type:'delta',state:'responding',text:fallbackText,fallback:true}); break; }
        } catch(error){ onEvent({type:'error',state:'error',label:'Recovery failed.',error:error?.message||String(error),partial:false}); return; }
        onEvent({type:'error',state:'error',label:'ULTRON produced no usable response.',error:'No displayable text was produced by the model or fallback tool loop.',partial:false}); return;
      }
      onEvent({type:'meta',state:'executing',label:`Executing ${toolCalls.length} tool ${toolCalls.length===1?'call':'calls'}.`,toolCalls});
      const toolResults=await executeToolCalls(toolCalls,options);
      onEvent({type:'tool',state:'executing',label:'Tool execution complete.',toolCalls,toolResults,tools:toolSummary(toolResults)});
      onEvent({type:'meta',state:'synthesizing',label:'Analyzing tool results and deciding what to do next.'});
      messages=[...messages,{role:'assistant',content:full||null,tool_calls:toolCalls},...toolConversationMessages(toolResults)];
      if(round===maxToolRounds){ finalResult={ok:false,response:'Tool execution limit reached before a final answer could be produced.',tool_results:toolResults,model:streamResult.model,task,guardian,critic}; }
    }
    if(!finalResult)return;
    await require('./telemetry').recordModelResult({model:finalResult.model,taskType:task.taskType,success:true,latencyMs:Date.now()-started});
    const createdAt=new Date().toISOString(); require('./memory/local-store').appendConversation({id:require('crypto').randomUUID(),role:'assistant',content:finalResult.response,model:finalResult.model,task_type:task.taskType,created_at:createdAt}); if(require('./memory/supabase').available()){try{await require('./memory/supabase').insertConversationMessage({role:'assistant',content:finalResult.response,model:finalResult.model,metadata:{task_type:task.taskType},created_at:createdAt});}catch{}}
    onEvent({type:'final',state:'responding',label:'Text generation complete. Voice output may follow.',result:{...finalResult,durationMs:Date.now()-started}});
  }
}
module.exports={Mark2Runtime,parseToolIntent,parseLegacyToolMarkup,updateMood};