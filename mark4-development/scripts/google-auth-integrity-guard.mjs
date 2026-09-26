#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const repo=path.resolve(root,"..");
const CONTRACT="google-auth-contract-v1";
const fail=message=>{throw new Error(`Google Auth Integrity Guard: ${message}`);};
const run=(cmd,args)=>{
  const result=spawnSync(cmd,args,{cwd:repo,encoding:"utf8"});
  if(result.status!==0)fail(`${cmd} ${args.join(" ")} failed: ${result.stderr||result.stdout}`);
  return result.stdout.trim();
};

const critical=[
  "services/capability-host/src/google-auth-recovery.mjs",
  "services/capability-host/src/workspace.mjs",
  "services/capability-host/src/server.mjs",
  "services/gateway/src/apollo-company-mission.mjs",
  "scripts/google-auth-integrity-guard.mjs",
  "scripts/google-auth-startup-check.mjs",
  "scripts/google-auth-doctor.mjs",
  "scripts/google-auth-connect.mjs"
];
for(const file of critical)if(!fs.existsSync(path.join(root,file)))fail(`missing critical file ${file}`);

const tracked=run("git",["ls-files"]).split(/\r?\n/).filter(Boolean);
const forbidden=/(^|\/)(google_token\.json|google-sheets-token\.json|google_client_secret\.json|client_secret[^/]*\.json|[^/]+\.oauth-token\.json)$/i;
for(const file of tracked)if(forbidden.test(file.replace(/\\/g,"/")))fail(`tracked credential file ${file}`);
for(const target of [
  ".ultron/credentials/google-sheets-token.json",
  ".ultron/credentials/google-sheets-oauth.json",
  "mark4-development/.runtime/hermes-home/google_token.json",
  "mark4-development/.runtime/hermes-home/google_client_secret.json"
]){
  const result=spawnSync("git",["check-ignore","-q",target],{cwd:repo});
  if(result.status!==0)fail(`credential path is not ignored: ${target}`);
}

const recovery=fs.readFileSync(path.join(root,"services/capability-host/src/google-auth-recovery.mjs"),"utf8");
const workspace=fs.readFileSync(path.join(root,"services/capability-host/src/workspace.mjs"),"utf8");
const mission=fs.readFileSync(path.join(root,"services/gateway/src/apollo-company-mission.mjs"),"utf8");
const checks=[
  ["source-root",recovery,/import\.meta\.url/],
  ["durable-refresh",recovery,/refresh_token/],
  ["refresh-preservation",recovery,/preservePreviousRefresh/],
  ["backup",recovery,/\.bak/],
  ["atomic-write",recovery,/renameSync/],
  ["bounded-backoff",recovery,/500,1500,4000/],
  ["single-flight-reauth",recovery,/interactiveAuthorizationInFlight/],
  ["loopback",recovery,/127\.0\.0\.1/],
  ["safe-ephemeral-port",recovery,/server\.listen\(0,"127\.0\.0\.1"/],
  ["pkce",recovery,/code_challenge_method:"S256"/],
  ["workspace-self-heal",workspace,/ensureGoogleWorkspace/],
  ["workspace-retry",workspace,/authRetried/],
  ["mission-google-preflight",mission,/googleSheetPreflight/]
];
for(const [name,source,pattern] of checks)if(!pattern.test(source))fail(`${name} contract missing`);
if(/process\.cwd\(\)/.test(recovery+workspace))fail("credential resolution depends on process.cwd()");
if(/localhost:1/.test(recovery+workspace))fail("unsafe localhost:1 callback reintroduced");

const frontend=tracked.filter(file=>/^mark4-development\/apps\/ui\/src\//.test(file));
for(const rel of frontend){
  const text=fs.readFileSync(path.join(repo,rel),"utf8");
  if(/refresh_token|client_secret|access_token/i.test(text))fail(`OAuth secret boundary crossed in frontend ${rel}`);
}
console.log(`Google Auth Integrity Guard passed: ${CONTRACT}; isolated token, durable refresh, browser reauth, retries, secrets ignored.`);
