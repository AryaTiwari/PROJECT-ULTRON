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
