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
  assert.match(dev,/addFallback\("custom", omniRoute\.model/);
  assert.match(dev,/baseUrl: omniRoute\.baseUrl/);
  assert.match(dev,/keyEnv: "OMNIROUTE_API_KEY"/);
  assert.match(dev,/ULTRON_M4_OMNIROUTE_TEST/);
  assert.match(dev,/OMNIROUTE TEST MODE ACTIVE/);
  assert.match(dev,/probeOmniRoute/);
});

test("OmniRoute test mode excludes direct providers and uses one real custom-endpoint rescue",()=>{
  assert.match(dev,/if \(omniRoute\.testMode\) \{/);
  assert.match(dev,/addFallback\("custom", "auto\/best-reasoning"/);
  assert.match(dev,/baseUrl: omniRoute\.baseUrl/);
  assert.match(dev,/keyEnv: "OMNIROUTE_API_KEY"/);
  assert.match(dev,/\} else \{[\s\S]*addFallback\("gemini"/);
  assert.doesNotMatch(dev,/addFallback\("omniroute", "auto\/best-coding"\)/);
});

test("OmniRoute test mode uses auto routing and explicit context length",()=>{
  assert.match(dev,/ULTRON_OMNIROUTE_TEST_MODEL/);
  assert.match(dev,/\|\| "auto"/);
  assert.match(dev,/auto\/best-reasoning/);
  assert.match(dev,/ULTRON_OMNIROUTE_CONTEXT_LENGTH/);
  assert.match(dev,/context_length/);
  assert.match(dev,/ULTRON_M4_OMNIROUTE_READY/);
});
