#!/usr/bin/env node
import { mark4GoogleAuth, GOOGLE_AUTH_CONTRACT } from "../services/capability-host/src/google-auth-recovery.mjs";
try{
  const before=mark4GoogleAuth.status();
  let checked;
  try{checked=await mark4GoogleAuth.ensureReady({interactive:false,forceRefresh:true});}
  catch(error){checked={ok:false,state:error.code||"ERROR",error:error.message};}
  console.log(JSON.stringify({
    contractVersion:GOOGLE_AUTH_CONTRACT,
    mark4Root:mark4GoogleAuth.mark4Root,
    hermesHome:mark4GoogleAuth.hermesHome,
    canonicalClientPath:mark4GoogleAuth.canonicalClientPath,
    canonicalTokenPath:mark4GoogleAuth.canonicalTokenPath,
    state:checked.state||before.state,
    durable:Boolean(checked.durable??before.durable),
    clientPresent:before.clientPresent,
    tokenPresent:before.tokenPresent,
    hasRefreshToken:before.hasRefreshToken,
    missingScopes:before.missingScopes,
    tokenExpiresAt:before.tokenExpiresAt,
    forcedRefreshVerified:Boolean(checked.ok)
  },null,2));
  if(!checked.ok)process.exitCode=2;
}catch(error){console.error(JSON.stringify({ok:false,error:error.code||error.message}));process.exitCode=1;}
