const config = require('./config');
const integrations = require('./integrations');
const web = require('./web');
const gitPublisher = require('./git-publisher');

const githubSchemas = [
  { type:'function', function:{ name:'github_status', description:'Check whether the local workspace is connected to a Git remote and whether the current branch is reachable on origin. Use before promising GitHub publication.', parameters:{ type:'object', properties:{ workspace:{type:'string'} } } } },
  { type:'function', function:{ name:'github_read_file', description:'Read a text file from the configured GitHub repository. Use when exact file contents are needed.', parameters:{ type:'object', properties:{ path:{type:'string'}, ref:{type:'string'} }, required:['path'] } } },
  { type:'function', function:{ name:'github_list', description:'List files or folders in the configured GitHub repository.', parameters:{ type:'object', properties:{ path:{type:'string'}, ref:{type:'string'} } } },
  { type:'function', function:{ name:'github_update_file', description:'Replace an existing text file in the configured GitHub repository. Requires the current file SHA and verifies by reading the file back.', parameters:{ type:'object', properties:{ path:{type:'string'}, content:{type:'string'}, sha:{type:'string'}, ref:{type:'string'} }, required:['path','content','sha'] } } },
  { type:'function', function:{ name:'github_create_file', description:'Create a new text file in the configured GitHub repository.', parameters:{ type:'object', properties:{ path:{type:'string'}, content:{type:'string'}, ref:{type:'string'} }, required:['path','content'] } } },
];

const webSchemas = [
  { type:'function', function:{ name:'web_fetch', description:'Fetch clean readable content from a public URL. TinyFish Fetch is primary and direct HTTP is fallback.', parameters:{ type:'object', properties:{ url:{type:'string'} }, required:['url'] } } },
  { type:'function', function:{ name:'web_search', description:'Search the live web through TinyFish Search and return structured current results.', parameters:{ type:'object', properties:{ query:{type:'string'}, limit:{type:'number'} }, required:['query'] } } },
];

const schemas = [...githubSchemas, ...webSchemas];
function schemasFor({ github = false, web: webEnabled = false } = {}) {
  return [...(github ? githubSchemas : []), ...(webEnabled ? webSchemas : [])];
}

function assertToken(){if(!config.githubToken)throw new Error('GITHUB_TOKEN is not configured.');}
async function execute(name,input={}){
  const ref=input.ref||config.githubBranch;
  if(name==='web_fetch')return{ok:true,tool:name,result:await web.fetchPage(input.url)};
  if(name==='web_search')return{ok:true,tool:name,result:await web.searchWeb(input.query,{limit:input.limit||5})};
  if(name==='github_status')return{ok:true,tool:name,result:gitPublisher.probe(input.workspace||config.projectRoot)};
  if(name==='github_read_file')return{ok:true,tool:name,result:await integrations.githubReadFile(input.path,ref)};
  if(name==='github_list')return{ok:true,tool:name,result:await integrations.githubList(input.path||'',ref)};
  if(name==='github_create_file'){assertToken();const url=`https://api.github.com/repos/${config.githubOwner}/${config.githubRepo}/contents/${String(input.path||'').split('/').map(encodeURIComponent).join('/')}`;const res=await integrations.jsonRequest(url,{method:'PUT',headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',Authorization:`Bearer ${config.githubToken}`},body:JSON.stringify({message:`feat(mark3): create ${input.path}`,content:Buffer.from(String(input.content||''),'utf8').toString('base64'),branch:ref})},30000);const verify=await integrations.githubReadFile(input.path,ref);if(verify.content!==String(input.content||''))throw new Error('GitHub create verification failed.');return{ok:true,tool:name,result:{path:input.path,sha:verify.sha,verified:true,commit:res.commit?.sha||null}};}
  if(name==='github_update_file'){assertToken();const url=`https://api.github.com/repos/${config.githubOwner}/${config.githubRepo}/contents/${String(input.path||'').split('/').map(encodeURIComponent).join('/')}`;const res=await integrations.jsonRequest(url,{method:'PUT',headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',Authorization:`Bearer ${config.githubToken}`},body:JSON.stringify({message:`feat(mark3): update ${input.path}`,content:Buffer.from(String(input.content||''),'utf8').toString('base64'),sha:String(input.sha),branch:ref})},30000);const verify=await integrations.githubReadFile(input.path,ref);if(verify.content!==String(input.content||''))throw new Error('GitHub update verification failed.');return{ok:true,tool:name,result:{path:input.path,sha:verify.sha,verified:true,commit:res.commit?.sha||null}};}
  throw new Error(`Unknown Mark 3 tool: ${name}`);
}
module.exports={schemas,githubSchemas,webSchemas,schemasFor,execute};
