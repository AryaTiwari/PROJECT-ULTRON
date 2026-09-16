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

test("all Mark4 launcher children suppress extra console windows on Windows",()=>{
  assert.match(dev,/windowsHide: process\.platform === "win32"/);
  assert.match(dev,/windowsHide:process\.platform==="win32"/);
});


test("Vite starts directly through Node without an extra cmd console",()=>{\n  assert.match(dev,/function runVite\\(\\)/);\n  assert.match(dev,/vite","bin","vite\\.js/);\n  assert.doesNotMatch(dev,/ComSpec|cmd\\.exe/);\n});\n