import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const dir=path.join(root,"services","gateway","test");
const files=fs.readdirSync(dir)
  .filter(name=>name.endsWith(".test.mjs"))
  .sort()
  .map(name=>path.join(dir,name));

if(!files.length){
  console.error("No gateway tests found.");
  process.exit(1);
}
console.log("gateway tests:",files.map(file=>path.basename(file)).join(", "));
const result=spawnSync(process.execPath,["--test",...files],{cwd:root,stdio:"inherit",env:process.env});
process.exit(result.status ?? 1);
