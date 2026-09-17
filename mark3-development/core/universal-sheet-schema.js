'use strict';

// Deterministic, model-free spreadsheet schema inference. Headers are evidence, not
// templates: cell distributions, repeated structure and slot hints all contribute.

const ROLE_NAMES = Object.freeze([
  'name','company','role','linkedin','linkedin_person','linkedin_company','phone','email',
  'website','location','details','source','status','notes',
]);

const ORDINAL_WORDS = Object.freeze({
  first:1, primary:1, one:1, second:2, two:2, third:3, three:3, fourth:4, four:4,
  fifth:5, five:5, sixth:6, six:6, seventh:7, seven:7, eighth:8, eight:8,
  ninth:9, nine:9, tenth:10, ten:10, eleventh:11, eleven:11, twelfth:12, twelve:12,
  thirteenth:13, thirteen:13, fourteenth:14, fourteen:14, fifteenth:15, fifteen:15,
  sixteenth:16, sixteen:16, seventeenth:17, seventeen:17, eighteenth:18, eighteen:18,
  nineteenth:19, nineteen:19, twentieth:20, twenty:20,
});

const FAMILIES = Object.freeze({
  name: new Set(['name','person','contact','lead','poc','representative','rep','individual','candidate']),
  company: new Set(['company','organisation','organization','employer','business','account','firm','client']),
  role: new Set(['role','title','designation','position','seniority','function','department','job']),
  linkedin: new Set(['linkedin','linked','profile']),
  phone: new Set(['phone','mobile','telephone','tel','cell','dial','whatsapp']),
  email: new Set(['email','mail']),
  website: new Set(['website','web','site','domain','homepage']),
  location: new Set(['location','city','state','country','region','geography','address']),
  details: new Set(['details','description','post','requirement','requirements','jd','vacancy','opening','context','content']),
  source: new Set(['source','reference','origin','found','evidence']),
  status: new Set(['status','stage','outcome','state','progress']),
  notes: new Set(['notes','note','remarks','remark','comments','comment']),
});

function normalizeHeader(value) {
  return String(value ?? '').toLowerCase().replace(/&/g,' and ').replace(/[_./\\-]+/g,' ')
    .replace(/[^a-z0-9+ ]+/g,' ').replace(/\s+/g,' ').trim();
}
function words(value) { return normalizeHeader(value).split(' ').filter(Boolean); }
function slotHint(value) {
  const h = normalizeHeader(value); if (!h) return null;
  const numeric = h.match(/(?:^|\s)(\d{1,2})(?:st|nd|rd|th)?(?:\s|$)/)?.[1]
    || h.match(/\b(?:poc|contact|person|decision maker|dm|lead)\s*(\d{1,2})\b/)?.[1];
  if (numeric) { const n = Number(numeric); if (Number.isInteger(n) && n >= 1 && n <= 99) return n; }
  for (const token of h.split(' ')) if (ORDINAL_WORDS[token]) return ORDINAL_WORDS[token];
  return null;
}

function looksEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim()); }
function looksPhone(value) {
  const text = String(value || '').trim(); if (!text || /linkedin|https?:\/\//i.test(text)) return false;
  const digits = text.replace(/\D/g,''); return digits.length >= 7 && digits.length <= 15 && /[+()\d -]/.test(text);
}
function linkedInKind(value) {
  const text = String(value || '').trim();
  if (!/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\//i.test(text)) return null;
  if (/linkedin\.com\/in\//i.test(text)) return 'linkedin_person';
  if (/linkedin\.com\/company\//i.test(text)) return 'linkedin_company';
  return 'linkedin';
}
function looksUrl(value) {
  const raw = String(value || '').trim(); if (!raw) return false;
  try { const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); return Boolean(url.hostname && url.hostname.includes('.')); } catch { return false; }
}

function valueSignature(values = []) {
  const nonEmpty = values.map((value) => String(value ?? '').trim()).filter(Boolean);
  const total = nonEmpty.length || 1; const ratio = (fn) => nonEmpty.filter(fn).length / total;
  return {
    samples: nonEmpty.length,
    nonEmptyRatio: values.length ? nonEmpty.length / values.length : 0,
    uniqueRatio: nonEmpty.length ? new Set(nonEmpty.map((v) => v.toLowerCase())).size / nonEmpty.length : 0,
    email: ratio(looksEmail), phone: ratio(looksPhone),
    linkedin: ratio((v) => Boolean(linkedInKind(v))),
    linkedinPerson: ratio((v) => linkedInKind(v) === 'linkedin_person'),
    linkedinCompany: ratio((v) => linkedInKind(v) === 'linkedin_company'),
    url: ratio((v) => looksUrl(v) && !linkedInKind(v)),
    numeric: ratio((v) => /^[-+]?\d+(?:[.,]\d+)?$/.test(v)),
  };
}

function familyHits(tokens, family) { let n = 0; for (const token of tokens) if (family.has(token)) n++; return n; }
function headerRoleScores(header, signature = {}) {
  const h = normalizeHeader(header); const tokens = h.split(' ').filter(Boolean);
  const scores = Object.fromEntries(ROLE_NAMES.map((role) => [role,0])); if (!h) return scores;
  for (const [role, family] of Object.entries(FAMILIES)) scores[role] += familyHits(tokens, family) * 18;

  // Canonical one-word headers are strong semantics. Broad terms such as "number"
  // are intentionally excluded and must instead be supported by value evidence.
  if (/^(?:company|organisation|organization|employer|business)$/.test(h)) scores.company += 48;
  if (/^(?:role|title|designation|position|seniority|function|department)$/.test(h)) scores.role += 46;
  if (/^(?:name|person|contact)$/.test(h)) scores.name += 38;
  if (/^(?:phone|mobile|telephone|cell|whatsapp)$/.test(h)) scores.phone += 50;
  if (/^(?:email|mail|e mail)$/.test(h)) scores.email += 52;

  if (/\b(full )?name\b/.test(h)) scores.name += 42;
  if (/\b(person|contact|poc|decision maker|candidate)\b/.test(h) && /\bname\b/.test(h)) scores.name += 34;
  if (/\b(company|organisation|organization|employer)\b/.test(h) && /\bname\b/.test(h)) scores.company += 45;
  if (/\bperson or company\b|\bcompany or person\b/.test(h)) { scores.name += 28; scores.company += 28; }
  if (/\b(job )?title\b|\bdesignation\b|\bposition\b/.test(h)) scores.role += 46;
  if (/\blinkedin\b/.test(h)) scores.linkedin += 52;
  if (/\blinkedin\b/.test(h) && /\b(company|organisation|organization|employer)\b/.test(h)) scores.linkedin_company += 75;
  if (/\blinkedin\b/.test(h) && /\b(person|contact|profile|candidate|poc)\b/.test(h)) scores.linkedin_person += 70;
  if (/\b(phone|mobile|telephone|cell)\b/.test(h) || /\bcontact (?:no|number)\b/.test(h)) scores.phone += 62;
  if (/\bemail\b|\be mail\b/.test(h)) scores.email += 68;
  if (/\b(website|web site|domain|homepage)\b/.test(h)) scores.website += 55;
  if (/\b(location|city|state|country|region)\b/.test(h)) scores.location += 52;
  if (/\b(post|job|requirement|vacancy|description|details|jd)\b/.test(h)) scores.details += 45;
  if (/\b(source|reference|evidence)\b/.test(h)) scores.source += 40;
  if (/\b(status|stage|outcome|progress)\b/.test(h)) scores.status += 45;
  if (/\b(notes?|remarks?|comments?)\b/.test(h)) scores.notes += 45;

  if ((signature.email || 0) >= .5) scores.email += 80 * signature.email;
  if ((signature.phone || 0) >= .5) scores.phone += 75 * signature.phone;
  if ((signature.linkedinPerson || 0) >= .35) { scores.linkedin_person += 90 * signature.linkedinPerson; scores.linkedin += 55 * signature.linkedinPerson; }
  if ((signature.linkedinCompany || 0) >= .35) { scores.linkedin_company += 90 * signature.linkedinCompany; scores.linkedin += 55 * signature.linkedinCompany; }
  if ((signature.linkedin || 0) >= .5) scores.linkedin += 60 * signature.linkedin;
  if ((signature.url || 0) >= .6 && (signature.linkedin || 0) < .2) scores.website += 45 * signature.url;

  if (/\bemail (?:status|verified|verification|confidence)\b/.test(h)) scores.email -= 60;
  if (/\bphone (?:status|verified|verification|type)\b/.test(h)) scores.phone -= 55;
  if (h === 'number' || h === 'no' || h === 'id') scores.phone = Math.min(scores.phone, signature.phone >= .5 ? 45 : 0);
  if (/\bcompany\b/.test(h)) scores.name -= 8;
  if (/\bperson|contact|poc|candidate\b/.test(h)) scores.company -= 8;
  return scores;
}
function bestRole(scores) {
  const ordered = Object.entries(scores).sort((a,b) => b[1]-a[1]); const [role,score] = ordered[0] || ['unknown',0]; const second = ordered[1]?.[1] || 0;
  return { role: score >= 24 ? role : 'unknown', confidence: score > 0 ? Math.max(0,Math.min(1,(score-Math.max(0,second*.35))/100)) : 0, score, margin: score-second };
}
function columnSamples(rows, headerRowIndex, index, limit=60) {
  const out=[]; for (let r=headerRowIndex+1;r<Math.min(rows.length,headerRowIndex+1+limit);r++) out.push(rows[r]?.[index] ?? ''); return out;
}
function analyzeColumns(rows, headerRowIndex) {
  const header=rows[headerRowIndex]||[]; const width=Math.max(header.length,...rows.slice(headerRowIndex+1,headerRowIndex+61).map((r)=>r?.length||0),0); const columns=[];
  for(let index=0;index<width;index++){
    const title=String(header[index]??'').trim(); const signature=valueSignature(columnSamples(rows,headerRowIndex,index)); const scores=headerRoleScores(title,signature); const selected=bestRole(scores); let role=selected.role;
    if(role==='linkedin'){
      if(signature.linkedinPerson>signature.linkedinCompany&&signature.linkedinPerson>=.25) role='linkedin_person';
      else if(signature.linkedinCompany>signature.linkedinPerson&&signature.linkedinCompany>=.25) role='linkedin_company';
    }
    columns.push({index,header:title,normalizedHeader:normalizeHeader(title),role,confidence:selected.confidence,score:selected.score,scores,slotHint:slotHint(title),signature});
  }
  return columns;
}
function headerRowScore(rows,rowIndex){
  const columns=analyzeColumns(rows,rowIndex); const recognized=columns.filter((c)=>c.role!=='unknown'&&c.score>=28); const roles=new Set(recognized.map((c)=>c.role));
  const contact=recognized.filter((c)=>['name','role','linkedin','linkedin_person','phone','email','company','linkedin_company'].includes(c.role)).length;
  const nonEmpty=(rows[rowIndex]||[]).filter((v)=>String(v??'').trim()).length;
  const sampleStrength=recognized.reduce((sum,c)=>sum+Math.min(1,Math.max(c.signature.email,c.signature.phone,c.signature.linkedin,c.signature.url)),0);
  return {rowIndex,score:recognized.length*12+roles.size*9+contact*7+Math.min(20,nonEmpty)+sampleStrength*12-rowIndex*.2,recognized:recognized.length,roles:roles.size,columns};
}
function detectHeaderRow(rows,options={}){
  if(!Array.isArray(rows)||!rows.length)return null; const max=Math.min(rows.length,Number(options.maxHeaderRows||20)); const ranked=[];
  for(let r=0;r<max;r++)ranked.push(headerRowScore(rows,r)); ranked.sort((a,b)=>b.score-a.score); const best=ranked[0];
  return best&&best.recognized>=2&&best.score>=35?{...best,rowNumber:best.rowIndex+1}:null;
}

function personSeed(c){
  if(c.role==='linkedin_person')return true; if(c.role!=='name')return false;
  return !(/\b(company|organisation|organization|employer)\b/.test(c.normalizedHeader)&&!/\bperson|contact|poc|candidate\b/.test(c.normalizedHeader));
}
function companySeed(c){return c.role==='company'||c.role==='linkedin_company';}
function canonicalPersonField(role){if(role==='linkedin_person'||role==='linkedin')return'linkedin';return['name','role','phone','email','company','location'].includes(role)?role:null;}
function canonicalCompanyField(role){if(role==='linkedin_company'||role==='linkedin')return'linkedin';return['company','website','phone','email','location'].includes(role)?role:null;}
function putField(group,field,column){
  if(!field)return; const old=group.fields[field];
  if(!old||column.confidence>old.confidence){if(old)group.alternates.push({field,...old});group.fields[field]={index:column.index,header:column.header,confidence:column.confidence,role:column.role};}
  else group.alternates.push({field,index:column.index,header:column.header,confidence:column.confidence,role:column.role});
}
function makeGroup(kind,ordinal,seed){return{id:`${kind}-${ordinal||'unscoped'}-${seed?.index??'x'}`,kind,ordinal:ordinal||null,seedIndex:seed?.index??null,fields:{},alternates:[],confidence:0};}
function explicitPersonGroups(columns){
  const map=new Map();
  for(const column of columns){
    if(!column.slotHint)continue; const field=canonicalPersonField(column.role); if(!field)continue;
    const personHeader=/\b(poc|person|contact|candidate|decision maker|dm|lead)\b/.test(column.normalizedHeader); const typed=['name','role','phone','email','linkedin_person'].includes(column.role);
    if(!personHeader&&!typed)continue; if(!map.has(column.slotHint))map.set(column.slotHint,makeGroup('person',column.slotHint,column)); putField(map.get(column.slotHint),field,column);
  }
  return map;
}
function assignPersonGroups(columns){
  const explicit=explicitPersonGroups(columns); const seeds=columns.filter(personSeed).sort((a,b)=>a.index-b.index); const groups=[]; const used=new Set();
  for(const[,group]of[...explicit.entries()].sort((a,b)=>a[0]-b[0])){groups.push(group);for(const field of Object.values(group.fields))used.add(field.index);}
  const seedGroups=[];
  for(let i=0;i<seeds.length;i++){
    const seed=seeds[i]; let group=seed.slotHint?explicit.get(seed.slotHint):null;
    if(!group){const occupied=new Set(groups.map((g)=>g.ordinal).filter(Boolean));let ordinal=seed.slotHint||i+1;while(occupied.has(ordinal))ordinal++;group=makeGroup('person',ordinal,seed);groups.push(group);}
    putField(group,canonicalPersonField(seed.role),seed);used.add(seed.index);seedGroups.push({seed,group});
  }
  if(!seedGroups.length){const contact=columns.find((c)=>['linkedin_person','phone','email','role'].includes(c.role));if(contact){const group=explicit.get(contact.slotHint)||makeGroup('person',contact.slotHint||1,contact);if(!groups.includes(group))groups.push(group);seedGroups.push({seed:contact,group});}}
  const ordered=seedGroups.sort((a,b)=>a.seed.index-b.seed.index);
  for(const column of columns){
    if(used.has(column.index))continue;const field=canonicalPersonField(column.role);if(!field||column.role==='company')continue;
    if(column.slotHint&&explicit.has(column.slotHint)){putField(explicit.get(column.slotHint),field,column);used.add(column.index);continue;}
    if(!ordered.length)continue;let target=ordered[0].group;for(const item of ordered){if(item.seed.index<=column.index)target=item.group;else break;}putField(target,field,column);used.add(column.index);
  }
  const ordinals=new Set(groups.map((g)=>g.ordinal).filter(Boolean));const first=groups.find((g)=>g.seedIndex!=null&&!columns[g.seedIndex]?.slotHint&&g.ordinal!==1);if(!ordinals.has(1)&&first)first.ordinal=1;
  for(const group of groups){const values=Object.values(group.fields);const identity=Number(Boolean(group.fields.name))+Number(Boolean(group.fields.linkedin));const contacts=Number(Boolean(group.fields.phone))+Number(Boolean(group.fields.email));group.confidence=Math.min(1,.22+identity*.28+contacts*.12+Math.min(.18,values.reduce((s,v)=>s+v.confidence,0)/Math.max(1,values.length)*.18));}
  return groups.filter((g)=>Object.keys(g.fields).length).sort((a,b)=>(a.ordinal||999)-(b.ordinal||999)||(a.seedIndex??999)-(b.seedIndex??999));
}
function assignCompanyGroups(columns,claimed=new Set()){
  const seeds=columns.filter((c)=>companySeed(c)&&!claimed.has(c.index)).sort((a,b)=>a.index-b.index);if(!seeds.length)return[];const groups=[];
  for(const seed of seeds){if(groups.some((g)=>Object.values(g.fields).some((f)=>f.index===seed.index)))continue;const group=makeGroup('company',seed.slotHint||groups.length+1,seed);putField(group,canonicalCompanyField(seed.role),seed);groups.push(group);}
  for(const column of columns){if(claimed.has(column.index))continue;const field=canonicalCompanyField(column.role);if(!field||column.role==='name'||!groups.length)continue;if(groups.some((g)=>Object.values(g.fields).some((v)=>v.index===column.index)))continue;let target=groups[0];for(const group of groups){if((group.seedIndex??-1)<=column.index)target=group;else break;}putField(target,field,column);}
  for(const group of groups)group.confidence=Math.min(1,.45+Object.keys(group.fields).length*.12);return groups;
}

function inferSchema(rows,options={}){
  const header=detectHeaderRow(rows,options);if(!header){const error=new Error('Could not infer a reliable spreadsheet header row or semantic column graph.');error.code='UNIVERSAL_SCHEMA_NOT_FOUND';throw error;}
  const columns=header.columns;const personGroups=assignPersonGroups(columns);const personIndexes=new Set(personGroups.flatMap((g)=>Object.values(g.fields).map((f)=>f.index)));const companyGroups=assignCompanyGroups(columns,personIndexes);const context={};
  for(const column of columns){if(personIndexes.has(column.index))continue;if(companyGroups.some((g)=>Object.values(g.fields).some((f)=>f.index===column.index)))continue;if(['details','location','source','status','notes','website','company'].includes(column.role)){(context[column.role]||=[]).push({index:column.index,header:column.header,confidence:column.confidence});}}
  const semantic=columns.filter((c)=>c.role!=='unknown');const groupEvidence=[...personGroups,...companyGroups].reduce((s,g)=>s+g.confidence,0);const confidence=Math.max(0,Math.min(1,.25+Math.min(.25,semantic.length*.025)+Math.min(.35,groupEvidence*.12)+Math.min(.15,header.score/400)));
  return{schemaVersion:1,headerRowIndex:header.rowIndex,headerRowNumber:header.rowNumber,confidence,columns,entityGroups:[...personGroups,...companyGroups],personGroups,companyGroups,contextColumns:context,fingerprint:columns.map((c)=>normalizeHeader(c.header)).join('|')};
}
function fieldIndex(group,field){return Number.isInteger(group?.fields?.[field]?.index)?group.fields[field].index:-1;}

module.exports={normalizeHeader,words,slotHint,looksEmail,looksPhone,linkedInKind,looksUrl,valueSignature,headerRoleScores,bestRole,analyzeColumns,detectHeaderRow,inferSchema,assignPersonGroups,assignCompanyGroups,fieldIndex};
