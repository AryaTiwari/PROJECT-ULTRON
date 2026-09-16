import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");

test("capability host exposes three-POC enrichment and canonical Google Sheet export",()=>{
  const server=fs.readFileSync(path.join(root,"services","capability-host","src","server.mjs"),"utf8");
  assert.match(server,/ultron_apollo_find_company_contacts/);
  assert.match(server,/ultron_google_sheet_from_leads/);
  assert.match(server,/2ND POC NAME \+ DESIGNATION/);
  assert.match(server,/3RD POC NAME \+ DESIGNATION/);
});

test("Google workspace wrapper preserves auth-required as structured state",()=>{
  const workspace=fs.readFileSync(path.join(root,"services","capability-host","src","workspace.mjs"),"utf8");
  assert.match(workspace,/status:"auth_required"/);
  assert.match(workspace,/Preserve the research mission/);
});

test("Google Sheet lead export uses LinkedIn-as-POC1 and two additional POCs",()=>{
  const server=fs.readFileSync(path.join(root,"services","capability-host","src","server.mjs"),"utf8");
  assert.match(server,/LINKEDIN LINK/);
  assert.match(server,/2ND POC NAME \+ DESIGNATION/);
  assert.match(server,/3RD POC NAME \+ DESIGNATION/);
  assert.doesNotMatch(server,/"PRIMARY NAME","PRIMARY ROLE"/);
  assert.match(server,/tertiaryContact/);
});

test("Apollo POC enrichment can exclude POC1 identity",()=>{
  const apollo=fs.readFileSync(path.join(root,"services","capability-host","src","apollo.mjs"),"utf8");
  assert.match(apollo,/excludeLinkedin/);
  assert.match(apollo,/excludeName/);
  assert.match(apollo,/excludeEmail/);
});
