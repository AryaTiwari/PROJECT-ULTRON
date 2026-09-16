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

test("OmniRoute test mode uses only OmniRoute alias fallbacks",()=>{
  const dev=fs.readFileSync(path.join(root,"scripts","dev.mjs"),"utf8");
  assert.match(dev,/if \(omniRoute\.testMode\) \{/);
  assert.match(dev,/addFallback\("omniroute", "auto\/best-reasoning"\)/);
  assert.match(dev,/addFallback\("omniroute", "auto\/best-coding"\)/);
  assert.match(dev,/addFallback\("omniroute", "auto"\)/);
  assert.match(dev,/ULTRON_OMNIROUTE_TEST_MODEL/);
  assert.match(dev,/auto\/best-fast/);
});

test("Windows OmniRoute startup is hidden and does not create a detached console lineage",()=>{
  const launcher=fs.readFileSync(path.join(root,"scripts","dev-omniroute-test.mjs"),"utf8");
  const ensure=fs.readFileSync(path.join(root,"scripts","ensure-omniroute.mjs"),"utf8");
  assert.match(launcher,/windowsHide:process\.platform==="win32"/);
  assert.match(ensure,/detached:process\.platform!=="win32"/);
  assert.match(ensure,/windowsHide:true/);
});
