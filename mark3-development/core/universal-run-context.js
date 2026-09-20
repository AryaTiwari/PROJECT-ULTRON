'use strict';
const { AsyncLocalStorage } = require('async_hooks');
const store = new AsyncLocalStorage();
const text = v => String(v ?? '').trim();
function current() { return store.getStore(); }
function create(options = {}) {
  return { startedAt: Date.now(), sources:new Map(), rowRefs:new WeakMap(), processed:new Set(), changed:new Set(), cells:new Map(), verified:new Set(), repaired:new Set(), added:new Set(), providers:{apollo:0,linkedin:0,publicSearch:0,ai:0,googleSheets:0}, pending:new Map(), cache:new Map(), maxAiCalls:Math.max(0,Math.min(3,Number(options.maxAiCalls ?? 3))), aiCalls:0 };
}
function run(options, fn) { return current() ? fn() : store.run(create(options),fn); }
function provider(name) { const c=current(); if(c) c.providers[name]=(c.providers[name]||0)+1; }
function ai() { const c=current(); if(!c)return true; if(c.aiCalls>=c.maxAiCalls)return false;c.aiCalls++;provider('ai');return true; }
function source(value) {
  const c=current();if(!c || !value?.schema || !value?.spreadsheetId)return;
  const key=value.spreadsheetId+'|'+value.sheetName;
  if(!c.sources.has(key))c.sources.set(key,{...value,rows:value.rows.map(row=>row.slice())});
  value.rows.forEach((row,index)=>c.rowRefs.set(row,{key,rowNumber:index+1}));
}
function processed(sourceValue,rowNumber){const c=current();if(c)c.processed.add(sourceValue.spreadsheetId+'|'+sourceValue.sheetName+'|'+rowNumber);}
function verified(row,group){const c=current(),ref=c?.rowRefs.get(row);if(ref)c.verified.add(ref.key+'|'+ref.rowNumber+'|'+group.id);}
function commit(id,changes) {
  const c=current();if(!c)return;
  const sheets=require('./google-sheets-operator');
  for(const change of changes){
    for(const [key,s] of c.sources){
      if(s.spreadsheetId!==id)continue;
      const prefix=sheets.quoteSheet(s.sheetName)+'!';if(!change.range?.startsWith(prefix))continue;
      const match=change.range.slice(prefix.length).match(/^([A-Z]+)(\d+)$/i);if(!match)continue;
      let col=0;for(const char of match[1].toUpperCase())col=col*26+char.charCodeAt(0)-64;col--;
      const rowNumber=Number(match[2]);if(rowNumber<=s.schema.headerRowNumber)continue;
      const row=s.rows[rowNumber-1]||[],cellKey=key+'|'+rowNumber+'|'+col;
      const before=text(row[col]);if(before===text(change.value))continue;
      const fieldGroup=(s.schema.personGroups||[]).find(g=>Object.values(g.fields).some(f=>f.index===col));
      const field=fieldGroup&&Object.keys(fieldGroup.fields).find(f=>fieldGroup.fields[f].index===col);
      c.cells.set(cellKey,{rowNumber,columnIndex:col,field,before,after:change.value,groupId:fieldGroup?.id});
      c.changed.add(key+'|'+rowNumber);
      if(fieldGroup){const groupKey=key+'|'+rowNumber+'|'+fieldGroup.id;
        const hasIdentity=['name','linkedin'].some(f=>fieldGroup.fields[f]&&text(row[fieldGroup.fields[f].index]));
        c.verified.add(groupKey);
        if(hasIdentity)c.repaired.add(groupKey);else if(['name','linkedin'].includes(field))c.added.add(groupKey);
      }
    }
  }
}
function pending(item,state='pending'){const c=current();if(c)c.pending.set(item.key||`${item.rowNumber}|${item.columnIndex}`,{...item,state});}
function snapshot(){const c=current();if(!c)return null;return {elapsedMs:Date.now()-c.startedAt,rowsProcessed:c.processed.size,rowsChanged:c.changed.size,cellsChanged:c.cells.size,contactsVerified:c.verified.size,existingContactsRepaired:c.repaired.size,newContactsAdded:c.added.size,phoneCellsFilled:[...c.cells.values()].filter(v=>v.field==='phone'&&!v.before).length,emailCellsFilled:[...c.cells.values()].filter(v=>v.field==='email'&&!v.before).length,providerCalls:{...c.providers},pending:[...c.pending.values()].filter(v=>v.state==='pending')};}
async function settledMap(items,fn,limit=4){const results=new Array(items.length);let next=0;await Promise.all(Array.from({length:Math.min(items.length,Math.max(1,limit))},async()=>{while(next<items.length){const index=next++;try{results[index]={status:'fulfilled',value:await fn(items[index],index)};}catch(reason){results[index]={status:'rejected',reason};}}}));return results;}
async function memo(key,fn){const c=current();if(!c)return fn();if(c.cache.has(key))return c.cache.get(key);const value=Promise.resolve().then(fn);c.cache.set(key,value);try{return await value;}catch(error){c.cache.delete(key);throw error;}}
module.exports={memo,current,run,provider,ai,source,processed,verified,commit,pending,snapshot,settledMap};
