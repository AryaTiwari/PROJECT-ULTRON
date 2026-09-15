import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
test("gateway entrypoint parses as valid JavaScript",()=>{
  const result=spawnSync(process.execPath,["--check",path.join(root,"src","server.mjs")],{encoding:"utf8"});
  assert.equal(result.status,0,result.stderr||result.stdout);
});
