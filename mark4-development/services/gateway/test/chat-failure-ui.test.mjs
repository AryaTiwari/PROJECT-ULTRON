import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");
test("chat surfaces terminal model-route failures in the cockpit",()=>{
  const app=fs.readFileSync(path.join(root,"apps","ui","src","App.tsx"),"utf8");
  assert.match(app,/MODEL ROUTE FAILED/);
  assert.match(app,/Runtime route failed:/);
  assert.match(app,/type==="run\.failed"/);
});
