import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { systemOverview } from "../src/system-overview.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");
const read=file=>fs.readFileSync(path.join(root,file),"utf8");

test("legacy mission artifact shapes cannot crash system bootstrap",()=>{
  const overview=systemOverview({
    missions:[
      {id:"legacy-object",objective:"Legacy",artifacts:{name:"Sheet row",url:"https://example.test"}},
      {id:"legacy-json",objective:"JSON","artifacts":"{\"name\":\"Saved result\"}"},
      {id:"normal",objective:"Array",artifacts:[{name:"Report"}]}
    ],
    health:{ok:true},
    modelFabric:[]
  });
  assert.equal(overview.artifacts.length,3);
  assert.deepEqual(overview.artifacts.map(x=>x.missionId),["legacy-object","legacy-json","normal"]);
});

test("gateway exposes liveness separately from deep readiness",()=>{
  const gateway=read("services/gateway/src/server.mjs");
  assert.match(gateway,/\/api\/health/);
  assert.match(gateway,/runtimeStatus/);
  assert.match(gateway,/status:"degraded"/);
  assert.match(gateway,/sessionError/);
});

test("launcher starts UI from gateway liveness without waiting for Hermes readiness",()=>{
  const launcher=read("scripts/dev.mjs");
  assert.match(launcher,/8787\/api\/health/);
  assert.doesNotMatch(launcher,/waitFor\("http:\/\/127\.0\.0\.1:8787\/api\/ready"/);
  assert.match(launcher,/critical:false/);
});

test("frontend uses one canonical gateway and supports immediate event retry",()=>{
  const api=read("apps/ui/src/api.ts");
  const app=read("apps/ui/src/App.tsx");
  assert.match(api,/VITE_ULTRON_GATEWAY_URL/);
  assert.match(api,/http:\/\/127\.0\.0\.1:8787/);
  assert.match(api,/close\.retry/);
  assert.match(app,/retryConnectivity/);
  assert.match(app,/Runtime diagnostics/);
  assert.match(app,/runtime\?\.status===\"degraded\"/);
});
