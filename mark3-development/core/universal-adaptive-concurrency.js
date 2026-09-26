'use strict';
const defaults=Object.freeze({googleReads:4,apolloDiscovery:3,apolloHydration:3,apolloPhoneReveal:2,linkedinFallback:1,aiRescue:1,googleWrites:1});
function create(overrides={}){const limits={...defaults,...overrides},stable={};return{get:key=>Math.max(1,Number(limits[key]||1)),feedback(key,outcome){const current=Math.max(1,Number(limits[key]||1));if(['429','rate_limit','timeout','overloaded'].includes(String(outcome)))limits[key]=Math.max(1,current-1);else if(outcome==='success'){stable[key]=(stable[key]||0)+1;if(stable[key]>=20){limits[key]=Math.min(Number(defaults[key]||current),current+1);stable[key]=0;}}return limits[key];},snapshot:()=>({...limits})};}
module.exports={defaults,create};
