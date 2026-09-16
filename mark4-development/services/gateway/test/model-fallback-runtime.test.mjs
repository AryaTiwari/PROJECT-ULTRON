import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");
const dev=fs.readFileSync(path.join(root,"scripts","dev.mjs"),"utf8");

test("dev syncs Hermes primary model and native fallback chain before gateway start",()=>{
  assert.match(dev,/syncHermesRuntimeConfig/);
  assert.match(dev,/api_max_retries: 1/);
  assert.match(dev,/gemini-3\.7-flash/);
  assert.match(dev,/gemini-3\.6-flash/);
  assert.match(dev,/NVIDIA_API_KEY/);
  const syncIndex=dev.indexOf("const runtimeModelPolicy = syncHermesRuntimeConfig()");
  const startIndex=dev.indexOf('run(hermesPython');
  assert.ok(syncIndex>=0 && startIndex>syncIndex);
});

test("normal dev startup does not block on headless browser smoke",()=>{
  assert.match(dev,/ULTRON_M4_UI_SMOKE/);
  assert.match(dev,/Browser smoke probe skipped/);
});

test("OmniRoute is a named OpenAI-compatible final fallback and has isolated test mode",()=>{
  assert.match(dev,/const omniRouteProviderYaml/);
  assert.match(dev,/key_env: "OMNIROUTE_API_KEY"/);
  assert.match(dev,/OMNIROUTE_BASE_URL/);
  assert.match(dev,/ULTRON_OMNIROUTE_DEFAULT_MODEL/);
  assert.match(dev,/addFallback\("omniroute", omniRoute\.model\)/);
  assert.match(dev,/ULTRON_M4_OMNIROUTE_TEST/);
  assert.match(dev,/OMNIROUTE TEST MODE ACTIVE/);
  assert.match(dev,/probeOmniRoute/);
});

test("OmniRoute test mode excludes direct-provider fallbacks and uses OmniRoute aliases only",()=>{
  assert.match(dev,/if \(omniRoute\.testMode\) \{[\s\S]*addFallback\("omniroute", "auto\/best-reasoning"\)/);
  assert.match(dev,/addFallback\("omniroute", "auto\/best-coding"\)/);
  assert.match(dev,/addFallback\("omniroute", "auto"\)/);
  assert.match(dev,/\} else \{[\s\S]*addFallback\("gemini"/);
});


test("OmniRoute test mode supplies alias failover and explicit context length",()=>{
  assert.match(dev,/ULTRON_OMNIROUTE_TEST_MODEL/);
  assert.match(dev,/auto\/best-fast/);
  assert.match(dev,/auto\/best-reasoning/);
  assert.match(dev,/auto\/best-coding/);
  assert.match(dev,/ULTRON_OMNIROUTE_CONTEXT_LENGTH/);
  assert.match(dev,/context_length/);
});
