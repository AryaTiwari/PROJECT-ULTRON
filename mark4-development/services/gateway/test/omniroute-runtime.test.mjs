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
});

test("Mark4 OmniRoute ensure is standalone and does not start Mark3",()=>{
  const ensure=fs.readFileSync(path.join(root,"scripts","ensure-omniroute.mjs"),"utf8");
  assert.match(ensure,/scripts","dev","run-next\.mjs/);
  assert.doesNotMatch(ensure,/start-mark3/);
  assert.match(ensure,/OMNIROUTE_DIR/);
  assert.match(ensure,/\/models/);
});

test("OmniRoute test mode masks direct providers including Grok xAI and forces every Mark4 role",()=>{
  const dev=fs.readFileSync(path.join(root,"scripts","dev.mjs"),"utf8");
  assert.match(dev,/XAI_API_KEY/);
  assert.match(dev,/GEMINI_API_KEY/);
  assert.match(dev,/NVIDIA_API_KEY/);
  assert.match(dev,/delete process\.env\[key\]/);
  assert.match(dev,/\["COGNITION","WORKER","VERIFIER","CREATIVE"\]/);
  assert.match(dev,/ULTRON_M4_\$\{role\}_PROVIDER/);
  assert.match(dev,/= "omniroute"/);
  assert.match(dev,/all direct model routes are disabled/);
});

test("OmniRoute test mode uses OmniRoute auto routing plus one real Hermes custom-endpoint rescue",()=>{
  const dev=fs.readFileSync(path.join(root,"scripts","dev.mjs"),"utf8");
  assert.match(dev,/if \(omniRoute\.testMode\) \{/);
  assert.match(dev,/addFallback\("custom", "auto\/best-reasoning"/);
  assert.match(dev,/baseUrl: omniRoute\.baseUrl/);
  assert.match(dev,/keyEnv: "OMNIROUTE_API_KEY"/);
  assert.match(dev,/ULTRON_OMNIROUTE_TEST_MODEL/);
  assert.match(dev,/auto\/best-fast/);\n  assert.match(dev,/auto\/best-reasoning/);
  assert.doesNotMatch(dev,/auto\/best-coding -> auto/);
});

test("Windows OmniRoute startup is hidden and does not create a detached console lineage",()=>{
  const launcher=fs.readFileSync(path.join(root,"scripts","dev-omniroute-test.mjs"),"utf8");
  const ensure=fs.readFileSync(path.join(root,"scripts","ensure-omniroute.mjs"),"utf8");
  assert.match(launcher,/windowsHide:process\.platform==="win32"/);
  assert.match(launcher,/ULTRON_M4_OMNIROUTE_READY="1"/);
  assert.match(ensure,/detached:false/);
  assert.match(ensure,/windowsHide:true/);
  assert.match(ensure,/hidden canonical run-next wrapper/);
});

test("OmniRoute warm launches avoid duplicate model probes and use bounded readiness fetches",()=>{
  const dev=fs.readFileSync(path.join(root,"scripts","dev.mjs"),"utf8");
  const ensure=fs.readFileSync(path.join(root,"scripts","ensure-omniroute.mjs"),"utf8");
  assert.match(dev,/ULTRON_M4_OMNIROUTE_READY/);
  assert.match(dev,/request timeout/);
  assert.match(ensure,/setTimeout\(\(\)=>controller\.abort\(\),1800\)/);
  assert.match(ensure,/waitReady\(state,timeoutMs=90000\)/);\n  assert.match(ensure,/Last OmniRoute output/);\n  assert.match(ensure,/launcher exited/);
});
