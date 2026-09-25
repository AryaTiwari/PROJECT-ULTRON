import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");
const read=(file)=>fs.readFileSync(path.join(root,file),"utf8");

test("cockpit exposes the complete Mark 4 navigation and control surfaces",()=>{
  const app=read("apps/ui/src/App.tsx");
  const command=read("apps/ui/src/components/CommandView.tsx");
  const drawer=read("apps/ui/src/components/SessionDrawer.tsx");
  const palette=read("apps/ui/src/components/CommandPalette.tsx");
  const mission=read("apps/ui/src/components/MissionView.tsx");
  const branches=read("apps/ui/src/components/BranchView.tsx");
  for(const label of ["Command","Missions","Branches","Operations"])assert.match(app,new RegExp(`label:\"${label}\"`));
  assert.match(app,/key\.toLowerCase\(\)===\"k\"/);
  assert.match(command,/approval-card/);
  assert.match(command,/attachment/);
  assert.match(drawer,/Mission linked/i);
  assert.match(palette,/Type a command or search/i);
  for(const field of ["strategy","constraints","blockers","evidence","relatedSessions","childBranches"])assert.match(mission,new RegExp(field,"i"));
  assert.match(branches,/Compare with parent/);
  assert.match(branches,/anchorMessageId/);
});

test("gateway persists full missions, branch context and bounded attachments",()=>{
  const gateway=read("services/gateway/src/server.mjs");
  const db=read("services/gateway/src/db.mjs");
  assert.match(gateway,/\/api\/attachments/);
  assert.ok(gateway.includes("10*1024*1024"));
  assert.match(gateway,/branch-context/);
  assert.match(gateway,/renameBranch/);
  for(const field of ["originalRequest","artifacts","blockers","approvals","relatedSessions","childBranches"])assert.match(db,new RegExp(field));
});

test("Mark 3 knowledge is migrated as native Mark 4 skills and memory",()=>{
  assert.ok(fs.existsSync(path.join(root,"hermes","MEMORY.md")));
  const expected=["adaptive-research","apollo-contact-enrichment","coding-and-publishing","creator-operations","google-sheets-operations","input-continuity","memory-reflection","multimodal-artifacts","outreach-approval","runtime-recovery"];
  for(const name of expected)assert.ok(fs.existsSync(path.join(root,"hermes","skills",name,"SKILL.md")),`${name} skill missing`);
  const launcher=read("scripts/dev.mjs");
  assert.match(launcher,/syncHermesWorkspace\(\)/);
  assert.match(launcher,/MEMORY\.md/);
  assert.match(launcher,/fs\.cpSync/);
  assert.ok(fs.existsSync(path.join(root,"docs","MARK3-CAPABILITY-MIGRATION.md")));
});
