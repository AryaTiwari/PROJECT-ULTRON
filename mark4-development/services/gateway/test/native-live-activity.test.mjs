import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");
const activity=fs.readFileSync(path.join(root,"apps/ui/src/activity.ts"),"utf8");
const api=fs.readFileSync(path.join(root,"apps/ui/src/api.ts"),"utf8");

test("native mission semantic events are subscribed in the Butler UI",()=>{for(const name of ["operation.selected","target.resolved","auth.ready","approval.required","approval.granted","apollo.search.started","apollo.search.completed","qualification.completed","deduplication.completed","selection.completed","sheet.write.started","sheet.write.completed","verification.completed","mission.completed"])assert.match(api,new RegExp(name.replace(".","\\.")));});
test("native Apollo stages map to cognitive-core activity states",()=>{for(const name of ["operation.selected","target.resolved","auth.ready","apollo.search","qualification.completed","deduplication.completed","selection.completed","sheet.write","verification.completed"])assert.match(activity,new RegExp(name.replace(".","\\.")));});
test("normal Live Activity suppresses low-level file, search and terminal noise",()=>assert.match(activity,/read file\|search file\|terminal/));
