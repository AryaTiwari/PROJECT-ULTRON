import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");
test("frontend has a non-React boot fallback and fatal overlay",()=>{
  const html=fs.readFileSync(path.join(root,"apps","ui","index.html"),"utf8");
  assert.match(html,/ultron-boot/);assert.match(html,/ultron-fatal/);assert.match(html,/__showUltronFatal/);
});
test("main render is protected by an error boundary and not StrictMode doubled",()=>{
  const main=fs.readFileSync(path.join(root,"apps","ui","src","main.tsx"),"utf8");
  assert.match(main,/UiErrorBoundary/);assert.doesNotMatch(main,/StrictMode/);
});
test("dev launcher performs a real browser paint smoke check",()=>{
  const dev=fs.readFileSync(path.join(root,"scripts","dev.mjs"),"utf8");
  assert.match(dev,/verifyBrowserMount/);assert.match(dev,/--dump-dom/);assert.match(dev,/u4-shell/);
});
