import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const ensure=spawnSync(process.execPath,[path.join(root,"scripts","ensure-omniroute.mjs")],{cwd:root,env:process.env,stdio:"inherit",shell:false});
if(ensure.status!==0)process.exit(ensure.status||1);
process.env.ULTRON_M4_OMNIROUTE_TEST="1";
await import("./dev.mjs");
