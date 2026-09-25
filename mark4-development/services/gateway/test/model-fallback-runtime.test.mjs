import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");
const dev=fs.readFileSync(path.join(root,"scripts","dev.mjs"),"utf8");
const policy=fs.readFileSync(path.join(root,"scripts","conversation-model-policy.mjs"),"utf8");

test("dev syncs the requested conversation policy before gateway start",()=>{
  assert.match(dev,/buildConversationModelPolicy/);
  assert.match(dev,/syncHermesRuntimeConfig/);
  assert.match(dev,/api_max_retries:/);
  assert.match(dev,/Math\.max\(2, fallbacks\.length \+ 1\)/);
  assert.match(policy,/GEMINI_APY_KEY/);
  assert.match(policy,/GEMINI_API_KEY2/);
  assert.match(policy,/GROK_API_KEY/);
  assert.match(policy,/GROK_API_KEY2/);
  assert.match(policy,/NVIDIA_API_KEY/);
  assert.match(policy,/opencode-free/);
  assert.match(policy,/big-pickle/);
  const syncIndex=dev.indexOf("const runtimeModelPolicy = syncHermesRuntimeConfig()");
  const startIndex=dev.indexOf('run(hermesPython');
  assert.ok(syncIndex>=0 && startIndex>syncIndex);
});

test("normal dev startup does not block on headless browser smoke",()=>{
  assert.match(dev,/ULTRON_M4_UI_SMOKE/);
  assert.match(dev,/Browser smoke probe skipped/);
});

test("OmniRoute remains a named OpenAI-compatible isolated diagnostic route",()=>{
  assert.match(dev,/const omniRouteProviderYaml/);
  assert.match(dev,/key_env: "OMNIROUTE_API_KEY"/);
  assert.match(dev,/OMNIROUTE_BASE_URL/);
  assert.match(dev,/ULTRON_M4_OMNIROUTE_TEST/);
  assert.match(dev,/OMNIROUTE TEST MODE ACTIVE/);
  assert.match(dev,/probeOmniRoute/);
});

test("normal conversation routing uses direct providers then Big Pickle",()=>{
  assert.match(dev,/selectedModelRoute\.fallbacks/);
  assert.match(dev,/candidate\.provider/);
  assert.match(dev,/x\.keyEnv/);
  assert.match(policy,/Big Pickle keyless fallback/);
  assert.doesNotMatch(policy,/OMNIROUTE/);
});

test("OmniRoute test mode uses auto routing and explicit context length",()=>{
  assert.match(dev,/ULTRON_OMNIROUTE_TEST_MODEL/);
  assert.match(dev,/\|\| "auto"/);
  assert.match(dev,/auto\/best-reasoning/);
  assert.match(dev,/ULTRON_OMNIROUTE_CONTEXT_LENGTH/);
  assert.match(dev,/context_length/);
  assert.match(dev,/ULTRON_M4_OMNIROUTE_READY/);
});
