#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { mark4GoogleAuth, GOOGLE_AUTH_CONTRACT } from "../services/capability-host/src/google-auth-recovery.mjs";
const status=mark4GoogleAuth.status();
if(!process.env.HERMES_HOME){
  const relative=path.relative(mark4GoogleAuth.mark4Root,path.resolve(mark4GoogleAuth.canonicalTokenPath));
  if(relative.startsWith("..")||path.isAbsolute(relative))throw new Error("GOOGLE_AUTH_CANONICAL_PATH_OUTSIDE_MARK4");
}
if(fs.existsSync(mark4GoogleAuth.canonicalTokenPath)){
  try{JSON.parse(fs.readFileSync(mark4GoogleAuth.canonicalTokenPath,"utf8"));}
  catch{if(!fs.existsSync(mark4GoogleAuth.backupTokenPath))throw new Error("GOOGLE_AUTH_TOKEN_CORRUPT_WITHOUT_BACKUP");}
}
console.log(`Google auth startup check passed: ${GOOGLE_AUTH_CONTRACT}; ${status.state}.`);
