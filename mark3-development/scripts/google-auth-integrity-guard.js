#!/usr/bin/env node
const fs=require('fs');
const path=require('path');
const {spawnSync}=require('child_process');

const root=path.resolve(__dirname,'..');
const repo=path.resolve(root,'..');
const CONTRACT='google-auth-contract-v1';
const fail=(message)=>{throw new Error(`Google Auth Integrity Guard: ${message}`);};
const run=(cmd,args,cwd=repo)=>{
  const result=spawnSync(cmd,args,{cwd,encoding:'utf8'});
  if(result.status!==0)fail(`${cmd} ${args.join(' ')} failed: ${result.stderr||result.stdout}`);
  return result.stdout.trim();
};
const critical=[
  'core/google-sheets-auth.js',
  'core/google-sheets-operator.js',
  'scripts/google-sheets-auth.js',
  'scripts/google-sheets-auth-doctor.js',
  'scripts/google-sheets-live-health.js',
  'scripts/google-sheets-auth-resilience-selftest.js',
  'server.js',
  'interface/app.js',
  'interface/style.css'
];
for(const file of critical)if(!fs.existsSync(path.join(root,file)))fail(`missing critical file ${file}`);

const tracked=run('git',['ls-files']).split(/\r?\n/).filter(Boolean);
const forbidden=/(^|\/)(google_token\.json|google-sheets-token\.json|google_client_secret\.json|client_secret[^/]*\.json|[^/]+\.oauth-token\.json)$/i;
for(const file of tracked)if(forbidden.test(file.replace(/\\/g,'/')))fail(`tracked credential file ${file}`);

for(const target of [
  '.ultron/credentials/google-sheets-token.json',
  '.ultron/credentials/google-sheets-oauth.json'
]){
  const result=spawnSync('git',['check-ignore','-q',target],{cwd:repo});
  if(result.status!==0)fail(`credential path is not ignored: ${target}`);
}

const auth=fs.readFileSync(path.join(root,'core/google-sheets-auth.js'),'utf8');
const operator=fs.readFileSync(path.join(root,'core/google-sheets-operator.js'),'utf8');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const ui=fs.readFileSync(path.join(root,'interface/app.js'),'utf8');
const authCli=fs.readFileSync(path.join(root,'scripts/google-sheets-auth.js'),'utf8');
const checks=[
  ['stable-project-root',auth,/config\.projectRoot/],
  ['refresh-token-preservation',auth,/fresh\.refresh_token\s*\|\|\s*token\.refresh_token/],
  ['backup-recovery',auth,/tokenBackupPath/],
  ['atomic-write',auth,/renameSync\(temp, file\)/],
  ['single-flight-reauth',auth,/interactiveAuthorizationInFlight/],
  ['interactive-reauth',auth,/ensureAccessToken/],
  ['loopback-only',auth,/127\.0\.0\.1/],
  ['pkce',auth,/code_challenge_method:\s*'S256'/],
  ['browser-launch-detection',auth,/child\.once\('error',\s*\(\)\s*=>\s*finish\(false\)\)/],
  ['manual-auth-url-event',auth,/google_auth_manual_url/],
  ['auth-event-sink',auth,/setEventSink/],
  ['oauth-client-compatibility',auth,/tokenClientCompatible/],
  ['scope-compatibility',auth,/tokenScopeCompatible/],
  ['client-mismatch-reauth',auth,/oauth_client_mismatch/],
  ['scope-mismatch-reauth',auth,/scope_incompatible/],
  ['stored-client-metadata',auth,/client_id:\s*client\.clientId/],
  ['server-auth-event-bridge',server,/setEventSink\(\(type, event\) => emit\(type, event\)\)/],
  ['ui-manual-auth-event',ui,/google_auth_manual_url/],
  ['ui-clickable-auth-link',ui,/class="event-action" href="\$\{escapeHtml\(e\.authUrl\)\}"/],
  ['cli-manual-auth-url',authCli,/Open Google authorization/],
  ['one-401-retry',operator,/__authRetried/],
  ['operator-auto-reauth',operator,/ensureAccessToken/]
];
for(const [name,source,pattern] of checks)if(!pattern.test(source))fail(`${name} contract missing`);
if(/process\.cwd\(\)/.test(auth))fail('credential resolution depends on process.cwd()');
if(/if\s*\(!browserOpened\)[\s\S]{0,220}server\.close\(/.test(auth))fail('browser-launch fallback closes the pending OAuth loopback flow');

const uiFiles=tracked.filter(file=>/^mark3-development\/(?:interface|ui|frontend)\//.test(file));
for(const rel of uiFiles){
  const text=fs.readFileSync(path.join(repo,rel),'utf8');
  if(/refresh_token|client_secret|access_token/i.test(text))fail(`OAuth secret boundary crossed in frontend ${rel}`);
}

console.log(`Google Auth Integrity Guard passed: ${CONTRACT}; stable paths, durable refresh, single-flight reauth, 401 retry, secrets ignored.`);
