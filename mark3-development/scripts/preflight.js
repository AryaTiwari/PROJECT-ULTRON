const fs=require('fs');
const path=require('path');
const {execFileSync}=require('child_process');
const root=path.resolve(__dirname,'..');
const required=['server.js','core/config.js','core/persistence.js','core/memory.js','core/workspace.js','core/model-intelligence.js','core/planner.js','core/verifier.js','core/integrations.js','core/tools.js','core/assistant.js','core/conversation.js','core/proactive.js','core/voice-orchestrator.js','interface/index.html','interface/style.css','interface/app.js'];
for(const rel of required){const file=path.join(root,rel);if(!fs.existsSync(file))throw new Error(`Missing required file: ${rel}`);}
const js=[];
function walk(dir){for(const n of fs.readdirSync(dir)){if(['node_modules','data','workspace'].includes(n))continue;const f=path.join(dir,n),s=fs.statSync(f);if(s.isDirectory())walk(f);else if(/\.(js|cjs|mjs)$/.test(n))js.push(f);}}
walk(root);
for(const file of js){try{execFileSync(process.execPath,['--check',file],{stdio:'inherit'});}catch{throw new Error(`JavaScript syntax check failed: ${path.relative(root,file)}`);}}
for(const rel of js.map(f=>path.relative(root,f))){const text=fs.readFileSync(path.join(root,rel),'utf8');if(/github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}/.test(text))throw new Error(`Possible secret embedded in source: ${rel}`);}
console.log(`ULTRON Mark 3 preflight passed: ${required.length} required files and ${js.length} JavaScript files validated.`);
