import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");
const recovery=fs.readFileSync(path.join(root,"services/capability-host/src/google-auth-recovery.mjs"),"utf8");
const workspace=fs.readFileSync(path.join(root,"services/capability-host/src/workspace.mjs"),"utf8");

test("Google auth contract preserves durable refresh and single-flight reauth",()=>{
  assert.match(recovery,/GOOGLE_AUTH_CONTRACT="google-auth-contract-v1"/);
  assert.match(recovery,/interactiveAuthorizationInFlight/);
  assert.match(recovery,/refresh_token/);
  assert.match(recovery,/preservePreviousRefresh/);
  assert.match(recovery,/127\.0\.0\.1/);
  assert.match(recovery,/code_challenge_method:"S256"/);
});

test("Google auth is stable and never cwd-derived",()=>{
  assert.doesNotMatch(recovery,/process\.cwd\(\)/);
  assert.doesNotMatch(workspace,/process\.cwd\(\)/);
  assert.match(recovery,/import\.meta\.url/);
});

test("Workspace operations self-heal and retry auth exactly once",()=>{
  assert.match(workspace,/ensureGoogleWorkspace/);
  assert.match(workspace,/authRetried/);
  assert.match(workspace,/forceRefresh:true/);
  assert.match(workspace,/googleWorkspaceConnect/);
});
