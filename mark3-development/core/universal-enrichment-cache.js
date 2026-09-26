'use strict';
const fs=require('fs'),path=require('path'),config=require('./config');
const FILE=process.env.ULTRON_M3_ENRICHMENT_CACHE_STORE?path.resolve(process.env.ULTRON_M3_ENRICHMENT_CACHE_STORE):path.join(config.projectRoot,'.ultron','universal-enrichment','cache.json');
const number=(name,fallback)=>{const value=Number(process.env[name]);return Number.isFinite(value)&&value>0?value:fallback;};
const ttl={positive:()=>number('ULTRON_M3_ENRICHMENT_CACHE_DAYS',30)*86400000,negative:()=>number('ULTRON_M3_ENRICHMENT_NEGATIVE_CACHE_DAYS',3)*86400000,employer:()=>number('ULTRON_M3_EMPLOYER_CACHE_DAYS',30)*86400000,personNoContact:()=>number('ULTRON_M3_PERSON_NO_CONTACT_CACHE_DAYS',14)*86400000};
function load(){try{const parsed=JSON.parse(fs.readFileSync(FILE,'utf8'));return{version:1,entries:parsed.entries||{}};}catch{return{version:1,entries:{}};}}
function save(state){fs.mkdirSync(path.dirname(FILE),{recursive:true});const entries=Object.entries(state.entries||{}).sort((a,b)=>Number(b[1]?.savedAt||0)-Number(a[1]?.savedAt||0)).slice(0,number('ULTRON_M3_ENRICHMENT_CACHE_MAX_ENTRIES',5000)),temp=FILE+'.tmp';fs.writeFileSync(temp,JSON.stringify({version:1,entries:Object.fromEntries(entries)}),{mode:0o600});if(fs.existsSync(FILE))fs.rmSync(FILE,{force:true});fs.renameSync(temp,FILE);}
const cacheKey=(namespace,key)=>`${namespace}:${key}`;
function get(namespace,key,at=Date.now()){const state=load(),entry=state.entries[cacheKey(namespace,key)];if(!entry||Number(entry.expiresAt||0)<=at)return{hit:false,value:null,negative:false};return{hit:true,value:entry.value,negative:Boolean(entry.negative),savedAt:entry.savedAt,expiresAt:entry.expiresAt};}
function set(namespace,key,value,options={}){const state=load(),negative=Boolean(options.negative),savedAt=Date.now(),ttlMs=Math.max(60000,Number(options.ttlMs|| (negative?ttl.negative():ttl.positive())));state.entries[cacheKey(namespace,key)]={value,negative,savedAt,expiresAt:savedAt+ttlMs};save(state);return value;}
function stats(at=Date.now()){const values=Object.values(load().entries||{}).filter(entry=>Number(entry.expiresAt||0)>at);return{entries:values.length,negativeEntries:values.filter(entry=>entry.negative).length,file:FILE};}
module.exports={FILE,ttl,load,save,get,set,stats};
