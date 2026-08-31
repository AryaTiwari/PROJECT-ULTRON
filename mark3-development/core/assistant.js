const config = require('./config');
const memory = require('./memory');
const workspace = require('./workspace');
const models = require('./model-intelligence');
const planner = require('./planner');
const verifier = require('./verifier');
const integrations = require('./integrations');
const voice = require('./voice-orchestrator');
const { emit } = require('./events');

const BASE_SYSTEM = `You are ULTRON Mark 3, a persistent personal operating assistant and strategic companion. You are calm, formidable, intelligent, composed, direct, practical, subtly playful, philosophical when useful, and willing to challenge avoidance. Act like a trusted friend plus elite executive assistant. Never invent live facts, model capabilities, tool results, or completed work. State facts, assumptions, estimates and judgments separately. Prefer deterministic tools when reliable. Verify consequential actions whenever possible. Maintain continuity with projects, commitments, decisions and recent context.`;

function textFromResponse(data) { const choice=data?.choices?.[0]; const content=choice?.message?.content??data?.response??data?.text??data?.content??''; if(typeof content==='string')return content.trim(); if(Array.isArray(content))return content.map(x=>typeof x==='string'?x:x?.text||'').join('').trim(); return String(content||'').trim(); }
function explicitGitHubPrompt(text) { const match=String(text).match(/\b(?:read|open|inspect|check)\s+([A-Za-z0-9._\-/]+)\s+(?:from|on|in)\s+github\b/i); return match?match[1]:null; }
function contextBlock(userMessage,retrieved,commitments,decisions,projects,modelIntelligence){return['WORKING CONTEXT:',JSON.stringify({recentMemories:retrieved,openCommitments:commitments.slice(0,8),decisions:decisions.slice(0,8),projects:projects.slice(0,8)}),'','MODEL INTELLIGENCE:',JSON.stringify({availableModelCount:modelIntelligence.live.count,models:modelIntelligence.live.models.slice(0,60),observedPerformance:modelIntelligence.observed.slice(0,40)}),'',`CURRENT USER REQUEST: ${userMessage}`].join('\n');}
async function handle(message,options={}){
  const userMessage=String(message||'').trim(); if(!userMessage)throw new Error('Message is required.');
  const started=Date.now(); emit('task_started',{message:userMessage});
  const taskType=options.taskType||'general';
  const retrieved=memory.retrieve(userMessage,{limit:config.maxContextItems});
  const commitments=workspace.listCommitments({status:'open'}), decisions=workspace.listDecisions(), projects=workspace.listProjects();
  let intelligence={live:{models:[],count:0},observed:[]}; try{intelligence=await models.intelligence(taskType);}catch(error){emit('model_catalog_unavailable',{error:error.message});}
  const plan=planner.createPlan(userMessage,taskType); emit('context_ready',{memoryCount:retrieved.length,commitments:commitments.length,projectCount:projects.length});
  const githubPath=explicitGitHubPrompt(userMessage);
  if(githubPath){
    emit('tool_started',{tool:'github_read_file',input:{path:githubPath,ref:config.githubBranch}});
    const file=await integrations.githubReadFile(githubPath,config.githubBranch);
    emit('tool_completed',{tool:'github_read_file',result:{path:file.path,sha:file.sha,size:file.size}});
    const response=`I inspected ${file.path} on GitHub (${file.sha.slice(0,7)}).\n\n${file.content.slice(0,12000)}`;
    const check=verifier.verifyText(response); verifier.report(check,'github-read-response');
    memory.remember({type:'episodic',content:`GitHub file inspected: ${githubPath}`,source:'tool',project:'ULTRON Mark 3',importance:0.35});
    emit('response_ready',{model:'deterministic-github',taskType});
    void voice.enqueue(response);
    emit('task_completed',{durationMs:Date.now()-started});
    return{ok:true,response,text:response,model:'deterministic-github',taskType,plan,tool:'github_read_file',sha:file.sha,modelIntelligence:intelligence};
  }
  emit('model_selection',{availableModels:intelligence.live.count,observed:intelligence.observed.length});
  const messages=[
    {role:'system',content:`${BASE_SYSTEM}\n\n${contextBlock(userMessage,retrieved,commitments,decisions,projects,intelligence)}`},
    ...(Array.isArray(options.history)?options.history.slice(-10).map(item=>({role:item.role==='assistant'?'assistant':'user',content:String(item.content||'')})):[]),
    {role:'user',content:userMessage},
  ];
  emit('model_started',{taskType});
  const data=await integrations.chat(messages,options.model||'auto'); const text=textFromResponse(data); const checked=verifier.report(verifier.verifyText(text),'model-response'); if(!checked.ok)throw new Error('Model returned an empty response.');
  const selectedModel=data?.model||options.model||'auto';
  models.record({provider:'omniroute',model:selectedModel,taskType,success:true,latencyMs:Date.now()-started});
  memory.remember({type:'episodic',content:`Completed ${taskType} task using ${selectedModel}.`,source:'model',importance:0.25});
  emit('response_ready',{model:selectedModel,taskType});
  void voice.enqueue(text);
  emit('task_completed',{durationMs:Date.now()-started});
  return{ok:true,response:text,text,model:selectedModel,taskType,plan,modelIntelligence:intelligence};
}
module.exports={handle,BASE_SYSTEM};
