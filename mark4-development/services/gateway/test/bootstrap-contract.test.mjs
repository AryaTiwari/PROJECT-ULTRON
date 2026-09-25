import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("bootstrap provisions Hermes API and browser prerequisites", () => {
  const script = fs.readFileSync(path.join(root, "scripts", "bootstrap.ps1"), "utf8");
  assert.match(script, /aiohttp==3\.14\.3/);
  assert.match(script, /agent-browser@\^0\.26\.0/);
  assert.match(script, /terminal:\s*[\r\n]+\s*backend: local[\s\S]*cwd:/);
  assert.match(script, /playwright install chromium/);
  assert.doesNotMatch(script, /AGENT_BROWSER_EXECUTABLE_PATH/);
});

test("dev launcher uses Hermes browser prefix without shell=true", () => {
  const script = fs.readFileSync(path.join(root, "scripts", "dev.mjs"), "utf8");
  assert.match(script, /process\.env\.PATH = hermesNode/);
  assert.doesNotMatch(script, /shell:\s*process\.platform/);
});

test("dev repairs missing runtime key aliases before any child starts",()=>{
  const script=fs.readFileSync(path.join(root,"scripts","dev.mjs"),"utf8");
  assert.match(script,/hermes-home", "\.env"/);
  assert.match(script,/ULTRON_M4_HERMES_API_KEY \|\| process\.env\.API_SERVER_KEY/);
  assert.match(script,/process\.env\.API_SERVER_KEY = sharedHermesKey/);
  assert.match(script,/ULTRON_M4_INTERNAL_KEY \|\|=/);
});
