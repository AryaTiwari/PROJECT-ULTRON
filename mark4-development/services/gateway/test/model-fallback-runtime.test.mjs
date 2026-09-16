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

test("FreeLLM is a named OpenAI-compatible fallback and has isolated test mode",()=>{
  assert.ok(dev.includes("const freeLlmProviderYaml"));
  assert.ok(dev.includes("  freellm:"));
  assert.match(dev,/key_env: "FREELLM_API_KEY"/);
  assert.match(dev,/FREELLM_API_BASE/);
  assert.match(dev,/FREELLM_MODEL/);
  assert.match(dev,/addFallback\("freellm", freeLlm\.model\)/);
  assert.match(dev,/ULTRON_M4_FREELLM_TEST/);
  assert.match(dev,/FREE LLM TEST MODE ACTIVE/);
  assert.match(dev,/probeFreeLlm/);
});

test("FreeLLM test mode excludes normal Gemini and NVIDIA fallbacks",()=>{
  assert.match(dev,/if \(!freeLlm\.testMode\) \{[\s\S]*addFallback\("gemini"/);
  assert.match(dev,/if \(freeLlm\.testMode\) \{[\s\S]*provider: "freellm"/);
});

test("FreeLLM unreachable error points to deterministic setup command",()=>{
  assert.match(dev,/npm run freellm:setup/);
  assert.match(dev,/FreeLLMAPI is not reachable/);
});
