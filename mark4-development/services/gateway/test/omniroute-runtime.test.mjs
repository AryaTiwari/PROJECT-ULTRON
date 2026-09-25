import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");

test("Mark4 OmniRoute test launcher ensures route before forcing cognition",()=>{
  const launcher=fs.readFileSync(path.join(root,"scripts","dev-omniroute-test.mjs"),"utf8");
  assert.match(launcher,/ensure-omniroute\.mjs/);
  assert.match(launcher,/ULTRON_M4_OMNIROUTE_TEST="1"/);
  assert.doesNotMatch(launcher,/spawnSync|spawn\(/);
});

test("Mark4 OmniRoute ensure uses the canonical standalone wrapper and never starts Mark3",()=>{
  const ensure=fs.readFileSync(path.join(root,"scripts","ensure-omniroute.mjs"),"utf8");
  assert.match(ensure,/scripts","dev","run-next\.mjs/);
  assert.doesNotMatch(ensure,/start-mark3/);
  assert.match(ensure,/OMNIROUTE_DIR/);
  assert.match(ensure,/\/models/);
  assert.match(ensure,/hidden canonical run-next wrapper/);
});

test("OmniRoute test mode masks direct providers including Grok xAI and forces every Mark4 role",()=>{
  const dev=fs.readFileSync(path.join(root,"scripts","dev.mjs"),"utf8");
  const policy=fs.readFileSync(path.join(root,"scripts","conversation-model-policy.mjs"),"utf8");
  assert.match(policy,/XAI_API_KEY/);
  assert.match(policy,/GEMINI_API_KEY/);
  assert.match(policy,/NVIDIA_API_KEY/);
  assert.match(dev,/delete process\.env\[key\]/);
  assert.match(dev,/\["COGNITION","WORKER","VERIFIER","CREATIVE"\]/);
  assert.match(dev,/ULTRON_M4_\$\{role\}_PROVIDER/);
  assert.match(dev,/= "omniroute"/);
  assert.match(dev,/all direct model routes are disabled/);
});

test("OmniRoute test mode uses resilient auto aliases plus one Hermes custom-endpoint rescue",()=>{
  const dev=fs.readFileSync(path.join(root,"scripts","dev.mjs"),"utf8");
  assert.match(dev,/if \(omniRoute\.testMode\) \{/);
  assert.match(dev,/addFallback\("custom", "auto\/best-reasoning"/);
  assert.match(dev,/baseUrl: omniRoute\.baseUrl/);
  assert.match(dev,/keyEnv: "OMNIROUTE_API_KEY"/);
  assert.match(dev,/ULTRON_OMNIROUTE_TEST_MODEL/);
  assert.match(dev,/auto\/best-fast/);
  assert.match(dev,/auto\/best-reasoning/);
});

test("Windows OmniRoute startup stays hidden without a detached console lineage",()=>{
  const ensure=fs.readFileSync(path.join(root,"scripts","ensure-omniroute.mjs"),"utf8");
  assert.match(ensure,/detached:false/);
  assert.match(ensure,/windowsHide:true/);
  assert.match(ensure,/powershell\.exe/);
  assert.match(ensure,/windowsHide:true/);
});

test("OmniRoute startup reports progress, exits early on child failure, and tails logs",()=>{
  const ensure=fs.readFileSync(path.join(root,"scripts","ensure-omniroute.mjs"),"utf8");
  assert.match(ensure,/waitReady\(state,timeoutMs=90000\)/);
  assert.match(ensure,/state\.exited/);
  assert.match(ensure,/OmniRoute still starting/);
  assert.match(ensure,/Last OmniRoute output/);
  assert.match(ensure,/launcher exited/);
});

test("OmniRoute stale listener cleanup is silent on Windows",()=>{
  const ensure=fs.readFileSync(path.join(root,"scripts","ensure-omniroute.mjs"),"utf8");
  assert.match(ensure,/stopStaleListener/);
  assert.match(ensure,/stdio:\["ignore","ignore","ignore"\]/);
  assert.match(ensure,/windowsHide:true/);
});
