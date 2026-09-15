import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),dir=path.join(root,"services","media-engine","test");
const files=fs.readdirSync(dir).filter(x=>x.endsWith(".test.mjs")).sort().map(x=>path.join(dir,x));
const result=spawnSync(process.execPath,["--test",...files],{cwd:root,stdio:"inherit",env:process.env});process.exit(result.status??1);
