import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");

test("FreeLLM setup pins the official runtime and localhost binding",()=>{
  const script=fs.readFileSync(path.join(root,"scripts","setup-freellm.ps1"),"utf8");
  assert.match(script,/ghcr\.io\/tashfeenahmed\/freellmapi:v0\.10\.1/);
  assert.match(script,/127\.0\.0\.1:3001:3001/);
  assert.match(script,/api\/ping/);
  assert.match(script,/FREELLM_API_KEY=freellmapi-YOUR-KEY/);
});

test("package exposes explicit setup and stop commands",()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
  assert.equal(pkg.scripts["freellm:setup"],"powershell -ExecutionPolicy Bypass -File scripts/setup-freellm.ps1");
  assert.match(pkg.scripts["freellm:stop"],/docker compose/);
});
