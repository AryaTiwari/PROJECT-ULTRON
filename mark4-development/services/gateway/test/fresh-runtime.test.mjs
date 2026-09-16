import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");
test("dev always reloads Hermes config instead of reusing stale gateway",()=>{
  const dev=fs.readFileSync(path.join(root,"scripts","dev.mjs"),"utf8");
  assert.match(dev,/gateway", "run", "--replace"/);
  assert.doesNotMatch(dev,/reusing existing gateway/);
});
