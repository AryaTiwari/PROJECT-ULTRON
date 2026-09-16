import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");

test("capability host exposes two-contact enrichment and canonical Google Sheet export",()=>{
  const server=fs.readFileSync(path.join(root,"services","capability-host","src","server.mjs"),"utf8");
  assert.match(server,/ultron_apollo_find_company_contacts/);
  assert.match(server,/ultron_google_sheet_from_leads/);
  assert.match(server,/SECONDARY NAME/);
});

test("Google workspace wrapper preserves auth-required as structured state",()=>{
  const workspace=fs.readFileSync(path.join(root,"services","capability-host","src","workspace.mjs"),"utf8");
  assert.match(workspace,/status:"auth_required"/);
  assert.match(workspace,/Preserve the research mission/);
});
