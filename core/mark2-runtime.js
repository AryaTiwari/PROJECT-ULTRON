const { UltronCore } = require('./ultron-core');
const { execute } = require('./executor');

function extractUrl(text) { const match=String(text||'').match(/https?:\/\/[^\s]+/i); return match?match[0].replace(/[),.!?]+$/,''):null; }
function parseToolIntent(message){
  const text=String(message||'').trim();
  if(/^speak(?:\s+out\s+loud|\s+this)?\s*[:,-]?\s+/i.test(text)) return {name:'speak_text',input:{text:text.replace(/^speak(?:\s+out\s+loud|\s+this)?\s*[:,-]?\s+/i,'').trim()}};
  if(/^say\s+/i.test(text)) return {name:'speak_text',input:{text:text.replace(/^say\s+/i,'').trim()}};
  if(/^(open|launch)\s+https?:\/\//i.test(text)) return {name:'open_url',input:{url:extractUrl(text)}};
  if(/^(show|list)\s+(files|folders|directory|files in)/i.test(text)){const m=text.match(/(?:in|of|at)\s+(.+)$/i);return {name:'list_directory',input:{path:m?m[1].replace(/^['"]|['"]$/g,''):'.'}};}
  if(/^(what('?s| is) my (computer|pc) (spec|system|hardware)|system info|computer info)$/i.test(text)) return {name:'system_info',input:{}};
  if(/^read file\s+/i.test(text))return{name:'read_file',input:{path:text.replace(/^read file\s+/i,'').trim()}};
  if(/^write file\s+/i.test(text)){try{return{name:'write_file',input:JSON.parse(text.replace(/^write file\s+/i,'').trim())}}catch{return null}}
  if(/^run powershell\s+/i.test(text))return{name:'run_powershell',input:{command:text.replace(/^run powershell\s+/i,'').trim()}};
  return null;
}
function parseLegacyToolMarkup(content){const text=String(content||'');const m=text.match(/<tool_call>[\s\S]*?<function=([^\s>]+)>[\s\S]*?<parameter=(\w+)>([\s\S]*?)<\/parameter>[\s\S]*?<\/tool_call>/i);return m?{name:m[1],input:{[m[2]]:m[3].trim()}}:null;}

class Mark2Runtime extends UltronCore{
  async handleMessage(message,options={}){
    const intent=parseToolIntent(message);
    if(intent){
      const risky=['run_powershell','write_file'].includes(intent.name);
      const guardian=require('./guardian').assess({message,action:risky?{destructive:true,requiresConfirmation:true}:null});
      const critic=require('./critic').analyze({message,plannedAction:risky?{destructive:true,externalSideEffect:true}:null},guardian);
      if(guardian.decision==='block')return{ok:true,blocked:true,response:guardian.reasons.join(' '),guardian,critic};
      if(guardian.decision==='warn'&&options.confirmed!==true)return{ok:true,requires_confirmation:true,response:`Guardian warning: ${guardian.reasons.join(' ')}`,guardian,critic,tool:intent};
      const result=await execute(intent.name,intent.input,{confirmed:options.confirmed===true,source:options.source||'core'});
      return{ok:result.ok,response:result.ok?(intent.name==='speak_text'?'Voice synthesis completed.':`${intent.name} completed.`):result.error,tool_result:result,guardian,critic};
    }
    const result=await super.handleMessage(message,options);
    const legacy=parseLegacyToolMarkup(result?.response);
    if(!legacy)return result;
    if(legacy.name==='speak_text'){
      const toolResult=await execute('speak_text',{text:String(legacy.input.text||'')},{confirmed:true,source:'model'});
      return{...result,response:toolResult.ok?'Voice synthesis completed.':toolResult.error,tool_result:toolResult,tool_markup_handled:true};
    }
    return{...result,response:'I did not execute that generated tool call because the requested tool is not one of ULTRON\'s registered tools.',tool_markup_rejected:legacy};
  }
}
module.exports={Mark2Runtime,parseToolIntent,parseLegacyToolMarkup};
