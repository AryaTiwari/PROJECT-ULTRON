import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");
test("launcher gates UI on deep readiness and explicit project cwd",()=>{
  const dev=fs.readFileSync(path.join(root,"scripts","dev.mjs"),"utf8");
  const policy=fs.readFileSync(path.join(root,"scripts","conversation-model-policy.mjs"),"utf8");
  assert.match(dev,/\/api\/ready/);
  assert.match(dev,/TERMINAL_CWD = root/);
  assert.match(policy,/gemini-3\.7-flash/);
});
test("gateway deep readiness validates session lifecycle",()=>{
  const server=fs.readFileSync(path.join(root,"services","gateway","src","server.mjs"),"utf8");
  assert.match(server,/pathname==="\/api\/ready"/);assert.match(server,/await hermes\.messages\(sessionId\)/);assert.match(server,/MODEL_RUNTIME_UNAVAILABLE/);
});
