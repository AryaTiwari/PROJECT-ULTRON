'use strict';
const fs=require('fs'),path=require('path');
const config=require('./config');
function filename(){return path.join(config.projectRoot,'.ultron','lead-enrichment','pending-email-assignments.json');}
function read(){try{return JSON.parse(fs.readFileSync(filename(),'utf8'));}catch(error){if(error.code==='ENOENT')return [];throw Object.assign(new Error('Saved email lookups could not be read safely.'),{code:'PENDING_CONTACT_STATE_INVALID',cause:error});}}
function save(items){const file=filename();fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(items,null,2),{mode:0o600});fs.renameSync(temp,file);}
function key(item){return [item.spreadsheetId,item.sheetName,item.rowNumber,item.columnIndex].join('|');}
function put(source,item){const value={...item,spreadsheetId:source.spreadsheetId,sheetName:source.sheetName,headerRowNumber:source.schema?.headerRowNumber||item.headerRowNumber};const items=read();const at=items.findIndex(old=>key(old)===key(value));if(at>=0)items[at]=value;else items.push(value);save(items);return value;}
function remove(item){save(read().filter(old=>key(old)!==key(item)||old.requestId!==item.requestId));}
function forSource(source){return read().filter(item=>item.spreadsheetId===source.spreadsheetId&&item.sheetName===source.sheetName);}
module.exports={read,put,remove,forSource,key};
