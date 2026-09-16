import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");
const dev=fs.readFileSync(path.join(root,"scripts","dev.mjs"),"utf8");

test("Hermes launches directly from pinned venv while Mark4 stays the process cwd",()=>{
  assert.match(dev,/hermesPython/);
  assert.ok(dev.includes('["-m", "hermes_cli.main", "gateway", "run", "--replace"], root'));
  assert.ok(!dev.includes('run("uv", ["run", "--directory", vendor'));
});

test("browser paint probe is diagnostic and cannot tear down a healthy stack",()=>{
  assert.match(dev,/UI paint smoke warning/);
  assert.match(dev,/Cockpit remains running/);
  assert.match(dev,/await verifyBrowserMount\(\)/);
});
