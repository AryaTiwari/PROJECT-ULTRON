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
