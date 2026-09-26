#!/usr/bin/env node
import { mark4GoogleAuth } from "../services/capability-host/src/google-auth-recovery.mjs";
try{
  const result=await mark4GoogleAuth.ensureReady({interactive:true,forceReauth:true});
  console.log(JSON.stringify({ok:Boolean(result.ok),state:result.state,durable:Boolean(result.durable),reauthorized:Boolean(result.reauthorized)},null,2));
  if(!result.ok)process.exitCode=2;
}catch(error){console.error(JSON.stringify({ok:false,error:error.code||error.message}));process.exitCode=1;}
