'use strict';

// Deterministic, model-free spreadsheet schema inference. Headers are evidence, not
// templates: cell distributions, repeated structure and slot hints all contribute.

const ROLE_NAMES = Object.freeze([
  'name','company','role','linkedin','linkedin_person','linkedin_company','phone','email',
  'website','location','details','source','status','notes',
]);
const ORDINAL_WORDS = Object.freeze({
  first:1,primary:1,one:1,second:2,secondary:2,two:2,third:3,three:3,fourth:4,four:4,fifth:5,five:5,sixth:6,six:6,
  seventh:7,seven:7,eighth:8,eight:8,ninth:9,nine:9,tenth:10,ten:10,eleventh:11,eleven:11,twelfth:12,twelve:12,
  thirteenth:13,thirteen:13,fourteenth:14,fourteen:14,fifteenth:15,fifteen:15,sixteenth:16,sixteen:16,
  seventeenth:17,seventeen:17,eighteenth:18,eighteen:18,nineteenth:19,nineteen:19,twentieth:20,twenty:20,
});
const FAMILIES = Object.freeze({
  name:new Set(['name','person','contact','lead','poc','representative','rep','individual','candidate']),
  company:new Set(['company','organisation','organization','employer','business','account','firm','client']),
  role:new Set(['role','title','designation','position','seniority','function','department','job']),
  linkedin:new Set(['linkedin','linked','profile']), phone:new Set(['phone','mobile','telephone','tel','cell','dial','whatsapp']),
  email:new Set(['email','mail']), website:new Set(['website','web','site','domain','homepage']),
  location:new Set(['location','city','state','country','region','geography','address']),
  details:new Set(['details','description','post','requirement','requirements','jd','vacancy','opening','context','content']),
  source:new Set(['source','reference','origin','found','evidence']), status:new Set(['status','stage','outcome','state','progress']),
  notes:new Set(['notes','note','remarks','remark','comments','comment']),
});

function normalizeHeader(value){return String(value??'').toLowerCase().replace(/\bp[\s./_-]*o[\s./_-]*c(?=[\s._-]|$)/g,'poc').replace(/&/g,' and ').replace(/[_./\\-]+/g,' ').replace(/[^a-z0-9+ ]+/g,' ').replace(/\s+/g,' ').trim();}

// ---------------------------------------------------------------------------
// Central semantic alias dictionary (one place for every header synonym).
// STRONG aliases are safe anywhere in a header; CONTEXTUAL aliases only count
// when an explicit POC/ordinal index scopes them ("POC 1 Number" = phone,
// but a bare "Number" is never assumed to be a phone column).
// ---------------------------------------------------------------------------
const FIELD_ALIAS_ORDER = Object.freeze(['status','phone','email','linkedin','website','role','company','name']);
const FIELD_ALIASES = Object.freeze({
  status: Object.freeze(['call outcome','outcome','status','stage','progress']),
  phone: Object.freeze(['phone number','mobile number','contact number','mobile no','contact no','phone','mobile','telephone','tel','cell','whatsapp']),
  email: Object.freeze(['email address','email id','e mail','email','mail']),
  linkedin: Object.freeze(['linkedin url','linkedin profile','linkedin link','profile link','profile url','linkedin','profile']),
  website: Object.freeze(['company website','company domain','website','web site','homepage','domain']),
  role: Object.freeze(['job title','job role','designation','title','role','position','seniority','department']),
  company: Object.freeze(['company name','organisation','organization','employer','company','business','firm']),
  name: Object.freeze(['full name','contact name','person name','poc name','display name','name','contact']),
});
const CONTEXTUAL_ALIASES = Object.freeze({
  phone: Object.freeze(['number','no']),
  company: Object.freeze(['account','client','org']),
  website: Object.freeze(['web']),
});
function escapeRegex(value){return String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function extractPocIndex(h){
  if(!h) return null;
  const numeric=h.match(/(?:^|\s)(\d{1,2})(?:st|nd|rd|th)?(?=\s|$)/)?.[1]
    || h.match(/\b(?:poc|contact|person|decision maker|dm|lead)\s*(\d{1,2})\b/)?.[1];
  if(numeric){const n=Number(numeric);if(Number.isInteger(n)&&n>=1&&n<=99)return n;}
  for(const token of h.split(' ')) if(ORDINAL_WORDS[token]) return ORDINAL_WORDS[token];
  return null;
}
// Deterministic, order-independent header semantics: exact alias > longest
// phrase alias > POC-scoped contextual alias. Never uses column position.
function semanticForHeader(value){
  const h=normalizeHeader(value);
  if(!h) return {normalized:'',pocIndex:null,field:null,source:null};
  const pocIndex=extractPocIndex(h);
  // "Person or Company Name" / "Company or Person Name" identities are person
  // names, never company seeds — preserve the historical person-anchor reading.
  if(/\b(?:person|contact|poc|decision maker)\s+or\s+company\b/.test(h)||/\bcompany\s+or\s+(?:person|contact|poc|decision maker)\b/.test(h))
    return {normalized:h,pocIndex,field:'name',source:'phrase-alias'};
  // "Company Link" / "Company LinkedIn" columns hold links, not the company
  // identity itself: they must attach to the company group as its LinkedIn
  // field instead of spawning a second company entity.
  if(/\b(?:company|organisation|organization|employer|business)\b/.test(h)&&/\b(?:link|url|profile|linkedin)\b/.test(h)&&!/\b(?:website|web site|domain|homepage)\b/.test(h))
    return {normalized:h,pocIndex,field:'linkedin',source:'company-link'};
  for(const field of FIELD_ALIAS_ORDER) if(FIELD_ALIASES[field].includes(h)) return {normalized:h,pocIndex,field,source:'exact-alias'};
  let best=null;
  const consider=(field,alias,contextual)=>{
    if(contextual && !pocIndex) return;
    const match=new RegExp(`(?:^| )${escapeRegex(alias)}( |$)`).exec(h);
    if(!match) return;
    const candidate={field,alias,index:match.index};
    if(!best||alias.length>best.alias.length||(alias.length===best.alias.length&&candidate.index<best.index)) best=candidate;
  };
  // Typed field aliases (phone/email/status/...) always outrank generic entity
  // words like "contact": "Contact Email" is an email column, "First Contact
  // Phone" is a phone column. Generic person wording only decides the field
  // when no typed alias is present ("Primary Contact", "Point of Contact").
  for(const field of FIELD_ALIAS_ORDER){
    if(field==='name') continue;
    for(const alias of FIELD_ALIASES[field]) consider(field,alias,false);
    for(const alias of (CONTEXTUAL_ALIASES[field]||[])) consider(field,alias,true);
  }
  if(!best) for(const alias of FIELD_ALIASES.name) consider('name',alias,false);
  if(best) return {normalized:h,pocIndex,field:best.field,source:pocIndex?'poc-qualified-alias':'phrase-alias'};
  return {normalized:h,pocIndex,field:null,source:null};
}
function words(value){return normalizeHeader(value).split(' ').filter(Boolean);}
function slotHint(value){return extractPocIndex(normalizeHeader(value));}
function looksEmail(value){return Boolean(require('./universal-contact-normalization').normalizeEmail(value));}
function looksPhone(value){const s=String(value||'').trim();if(!s||/linkedin|https?:\/\//i.test(s))return false;const d=s.replace(/\D/g,'');return d.length>=7&&d.length<=15&&/[+()\d -]/.test(s);}
function linkedInKind(value){const s=String(value||'').trim();if(!/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\//i.test(s))return null;if(/linkedin\.com\/in\//i.test(s))return'linkedin_person';if(/linkedin\.com\/company\//i.test(s))return'linkedin_company';return'linkedin';}
function looksUrl(value){const s=String(value||'').trim();if(!s)return false;try{const u=new URL(/^https?:\/\//i.test(s)?s:`https://${s}`);return Boolean(u.hostname&&u.hostname.includes('.'));}catch{return false;}}
function valueSignature(values=[]){const a=values.map((v)=>String(v??'').trim()).filter(Boolean),n=a.length||1,r=(fn)=>a.filter(fn).length/n;return{samples:a.length,nonEmptyRatio:values.length?a.length/values.length:0,uniqueRatio:a.length?new Set(a.map((v)=>v.toLowerCase())).size/a.length:0,email:r(looksEmail),phone:r(looksPhone),linkedin:r((v)=>Boolean(linkedInKind(v))),linkedinPerson:r((v)=>linkedInKind(v)==='linkedin_person'),linkedinCompany:r((v)=>linkedInKind(v)==='linkedin_company'),url:r((v)=>looksUrl(v)&&!linkedInKind(v)),numeric:r((v)=>/^[-+]?\d+(?:[.,]\d+)?$/.test(v))};}
function familyHits(tokens,family){let n=0;for(const t of tokens)if(family.has(t))n++;return n;}
function headerRoleScores(header,signature={}){
  const h=normalizeHeader(header),tokens=h.split(' ').filter(Boolean),scores=Object.fromEntries(ROLE_NAMES.map((r)=>[r,0]));if(!h)return scores;
  for(const[role,family]of Object.entries(FAMILIES))scores[role]+=familyHits(tokens,family)*18;
  if(/^(?:company|organisation|organization|employer|business)$/.test(h))scores.company+=48;
  if(/^(?:role|title|designation|position|seniority|function|department)$/.test(h))scores.role+=46;
  if(/^(?:name|person|contact|lead|candidate)$/.test(h))scores.name+=38;
  if (/\b(?:poc|decision maker|recruiter)\b/.test(h) && !/\b(?:phone|mobile|email|mail|linkedin|profile|role|title|designation|number|no)\b/.test(h)) scores.name+=48;
  // A numbered/ordinal "First Contact" or "Contact 2" identifies the person
  // group. Do not classify ambiguous bare "Contact" as a name, and never
  // override a more explicit contact-data field ("Contact Phone 2", etc.).
  if (slotHint(h) && /\b(?:contact|person|lead)\b/.test(h)
    && !/\b(?:phone|mobile|email|mail|linkedin|profile|role|title|designation|number|no)\b/.test(h)) {
    scores.name+=55;
  }
  if(/^(?:phone|mobile|telephone|cell|whatsapp)$/.test(h))scores.phone+=50;
  if(/^(?:email|mail|e mail)$/.test(h))scores.email+=52;
  if(/^(?:profile|profile url)$/.test(h))scores.linkedin_person+=65;
  if(/\b(?:company|organisation|organization|employer|firm|business)\b/.test(h) && !/\b(?:phone|mobile|email|mail|linkedin|profile|contact|person)\b/.test(h))scores.company+=40;
  if(/\b(full )?name\b/.test(h))scores.name+=42;if(/\b(person|contact|poc|decision maker|candidate)\b/.test(h)&&/\bname\b/.test(h))scores.name+=34;
  if(/\b(company|organisation|organization|employer)\b/.test(h)&&/\bname\b/.test(h))scores.company+=45;if(/\bperson or company\b|\bcompany or person\b/.test(h)){scores.name+=28;scores.company+=28;}
  if(/\b(job )?title\b|\bdesignation\b|\bposition\b/.test(h))scores.role+=46;if(/\blinkedin\b/.test(h))scores.linkedin+=52;
  if(/\blinkedin\b/.test(h)&&/\b(company|organisation|organization|employer)\b/.test(h))scores.linkedin_company+=75;if(/\blinkedin\b/.test(h)&&/\b(person|contact|profile|candidate|poc)\b/.test(h))scores.linkedin_person+=70;
  if(/\b(phone|mobile|telephone|cell)\b/.test(h)||/\bcontact (?:no|number)\b/.test(h))scores.phone+=62;if(/\bemail\b|\be mail\b|\bmail\b/.test(h))scores.email+=68;
  if(/\b(website|web site|domain|homepage)\b/.test(h))scores.website+=55;if(/\b(location|city|state|country|region)\b/.test(h))scores.location+=52;
  if(/\b(post|job|requirement|vacancy|description|details|jd)\b/.test(h))scores.details+=45;if(/\b(source|reference|evidence)\b/.test(h))scores.source+=40;if(/\b(status|stage|outcome|progress)\b/.test(h))scores.status+=45;if(/\b(notes?|remarks?|comments?)\b/.test(h))scores.notes+=45;
  if((signature.email||0)>=.5)scores.email+=80*signature.email;if((signature.phone||0)>=.5)scores.phone+=75*signature.phone;
  if((signature.linkedinPerson||0)>=.35){scores.linkedin_person+=90*signature.linkedinPerson;scores.linkedin+=55*signature.linkedinPerson;}if((signature.linkedinCompany||0)>=.35){scores.linkedin_company+=90*signature.linkedinCompany;scores.linkedin+=55*signature.linkedinCompany;}if((signature.linkedin||0)>=.5)scores.linkedin+=60*signature.linkedin;if((signature.url||0)>=.6&&(signature.linkedin||0)<.2)scores.website+=45*signature.url;
  if(/\bemail (?:status|verified|verification|confidence)\b/.test(h))scores.email-=60;if(/\bphone (?:status|verified|verification|type)\b/.test(h))scores.phone-=55;  if(h==='number'||h==='no'||h==='id')scores.phone=Math.min(scores.phone,signature.phone>=.5?45:0);if(/\bcompany\b/.test(h))scores.name-=8;if(/\bperson|contact|poc|candidate\b/.test(h))scores.company-=8;
  // Semantic alias resolution is the strongest deterministic signal: an
  // explicit POC-qualified alias ("2nd POC Mobile") or an exact alias
  // ("Designation") outranks incidental token matches and column position.
  const sem=semanticForHeader(header);
  if(sem.field&&scores[sem.field]!==undefined){
    if(sem.pocIndex) scores[sem.field]+=85;
    else if(sem.source==='exact-alias') scores[sem.field]+=75;
    else scores[sem.field]+=60;
    if(sem.field==='status'&&sem.pocIndex) scores.status+=40; // "2nd POC call outcome" is a status column, never a POC identity
  }
  return scores;
}
function bestRole(scores){const a=Object.entries(scores).sort((x,y)=>y[1]-x[1]),[role,score]=a[0]||['unknown',0],second=a[1]?.[1]||0;return{role:score>=24?role:'unknown',confidence:score>0?Math.max(0,Math.min(1,(score-Math.max(0,second*.35))/100)):0,score,margin:score-second};}
function columnSamples(rows,h,i,limit=60){const a=[];for(let r=h+1;r<Math.min(rows.length,h+1+limit);r++)a.push(rows[r]?.[i]??'');return a;}
function analyzeColumns(rows,h){const header=rows[h]||[],width=Math.max(header.length,...rows.slice(h+1,h+61).map((r)=>r?.length||0),0),out=[];for(let i=0;i<width;i++){const title=String(header[i]??'').trim(),signature=valueSignature(columnSamples(rows,h,i)),scores=headerRoleScores(title,signature),selected=bestRole(scores);let role=selected.role;if(role==='linkedin'){if(signature.linkedinPerson>signature.linkedinCompany&&signature.linkedinPerson>=.25)role='linkedin_person';else if(signature.linkedinCompany>signature.linkedinPerson&&signature.linkedinCompany>=.25)role='linkedin_company';}out.push({index:i,header:title,normalizedHeader:normalizeHeader(title),role,confidence:selected.confidence,score:selected.score,scores,slotHint:slotHint(title),signature});}return out;}
function headerRowScore(rows,rowIndex){const columns=analyzeColumns(rows,rowIndex),recognized=columns.filter((c)=>c.role!=='unknown'&&c.score>=28),roles=new Set(recognized.map((c)=>c.role)),contact=recognized.filter((c)=>['name','role','linkedin','linkedin_person','phone','email','company','linkedin_company'].includes(c.role)).length,nonEmpty=(rows[rowIndex]||[]).filter((v)=>String(v??'').trim()).length,sampleStrength=recognized.reduce((s,c)=>s+Math.min(1,Math.max(c.signature.email,c.signature.phone,c.signature.linkedin,c.signature.url)),0);return{rowIndex,score:recognized.length*12+roles.size*9+contact*7+Math.min(20,nonEmpty)+sampleStrength*12-rowIndex*.2,recognized:recognized.length,roles:roles.size,columns};}
function detectHeaderRow(rows,options={}){if(!Array.isArray(rows)||!rows.length)return null;const max=Math.min(rows.length,Number(options.maxHeaderRows||20)),ranked=[];for(let r=0;r<max;r++)ranked.push(headerRowScore(rows,r));ranked.sort((a,b)=>b.score-a.score);const best=ranked[0];return best&&best.recognized>=2&&best.score>=35?{...best,rowNumber:best.rowIndex+1}:null;}

function personSeed(c){if(c.role!=='name')return false;return !(/\b(company|organisation|organization|employer)\b/.test(c.normalizedHeader)&&!/\bperson|contact|poc|candidate\b/.test(c.normalizedHeader));}
function companySeed(c){return c.role==='company'||c.role==='linkedin_company';}
function canonicalPersonField(role){if(role==='linkedin_person'||role==='linkedin')return'linkedin';return['name','role','phone','email','company','location'].includes(role)?role:null;}
function canonicalCompanyField(role){if(role==='linkedin_company'||role==='linkedin')return'linkedin';return['company','website','phone','email','location'].includes(role)?role:null;}
function putAlternate(g,entry){const list=g.alternates||(g.alternates=[]);if(!list.some((item)=>item.field===entry.field&&Number(item.index)===Number(entry.index)))list.push(entry);}
function putField(g,f,c){if(!f)return;const old=g.fields[f];if(!old||c.confidence>old.confidence){if(old)putAlternate(g,{field:f,...old,score:old.score??c.score??null});g.fields[f]={index:c.index,header:c.header,confidence:c.confidence,role:c.role,score:c.score??old?.score??null};}else putAlternate(g,{field:f,index:c.index,header:c.header,confidence:c.confidence,role:c.role,score:c.score??null});}
function makeGroup(kind,ordinal,seed){return{id:`${kind}-${ordinal||'unscoped'}-${seed?.index??'x'}`,kind,ordinal:ordinal||null,seedIndex:seed?.index??null,fields:{},alternates:[],confidence:0};}
function explicitPersonGroups(columns){const map=new Map();for(const c of columns){if(!c.slotHint)continue;const f=canonicalPersonField(c.role);if(!f)continue;const headerPerson=/\b(poc|person|contact|candidate|decision maker|dm|lead)\b/.test(c.normalizedHeader),typed=['name','role','phone','email','linkedin_person'].includes(c.role);if(!headerPerson&&!typed)continue;if(!map.has(c.slotHint))map.set(c.slotHint,makeGroup('person',c.slotHint,c));putField(map.get(c.slotHint),f,c);}return map;}
function assignPersonGroups(columns){
  const explicit=explicitPersonGroups(columns),nameSeeds=columns.filter(personSeed).sort((a,b)=>a.index-b.index),groups=[],used=new Set();
  for(const[,g]of[...explicit.entries()].sort((a,b)=>a[0]-b[0])){groups.push(g);for(const f of Object.values(g.fields))used.add(f.index);}
  const seedGroups=[];
  for(let i=0;i<nameSeeds.length;i++){const seed=nameSeeds[i];let group=seed.slotHint?explicit.get(seed.slotHint):null;if(!group){const occupied=new Set(groups.map((g)=>g.ordinal).filter(Boolean));let ordinal=seed.slotHint||i+1;while(occupied.has(ordinal))ordinal++;group=makeGroup('person',ordinal,seed);groups.push(group);}putField(group,'name',seed);used.add(seed.index);seedGroups.push({seed,group});}
  // Only use a LinkedIn/contact field as a structural seed when there is no name seed.
  // Explicit slot hints still create as many link-only groups as the sheet defines.
  if(!seedGroups.length){const unscoped=columns.filter((c)=>['linkedin_person','phone','email','role'].includes(c.role)&&!c.slotHint);if(unscoped.length){const seed=unscoped[0],group=makeGroup('person',1,seed);if(!groups.includes(group))groups.push(group);seedGroups.push({seed,group});}}
  const ordered=seedGroups.sort((a,b)=>a.seed.index-b.seed.index);
  for(const c of columns){if(used.has(c.index))continue;const f=canonicalPersonField(c.role);if(!f||c.role==='company')continue;if(c.slotHint&&explicit.has(c.slotHint)){putField(explicit.get(c.slotHint),f,c);used.add(c.index);continue;}if(!ordered.length)continue;
    // A company-level LinkedIn column before the first POC name (e.g. A=Company,
    // C=LinkedIn, D:F=POC-1) belongs to the company, not the first person.
    // Assigning it to POC-1 made a blank D:F look like a company anchor and
    // excluded POC-1 from new-contact discovery entirely.
    const companyPrecedesLink=columns.some((seed)=>seed.index<c.index&&companySeed(seed));
    const prePocCompanyLink=c.index<ordered[0].seed.index
      &&(c.role==='linkedin'||c.role==='linkedin_company')
      &&companyPrecedesLink
      &&Number(c.signature?.linkedinPerson||0)<0.25;
    if(prePocCompanyLink)continue;
    let target=ordered[0].group;for(const item of ordered){if(item.seed.index<=c.index)target=item.group;else break;}putField(target,f,c);used.add(c.index);}
  const ordinals=new Set(groups.map((g)=>g.ordinal).filter(Boolean)),first=groups.find((g)=>g.seedIndex!=null&&!columns[g.seedIndex]?.slotHint&&g.ordinal!==1);if(!ordinals.has(1)&&first)first.ordinal=1;
  for(const g of groups){const values=Object.values(g.fields),identity=Number(Boolean(g.fields.name))+Number(Boolean(g.fields.linkedin)),contacts=Number(Boolean(g.fields.phone))+Number(Boolean(g.fields.email));g.confidence=Math.min(1,.22+identity*.28+contacts*.12+Math.min(.18,values.reduce((s,v)=>s+v.confidence,0)/Math.max(1,values.length)*.18));}
  return groups.filter((g)=>Object.keys(g.fields).length).sort((a,b)=>(a.ordinal||999)-(b.ordinal||999)||(a.seedIndex??999)-(b.seedIndex??999));
}
function assignCompanyGroups(columns,claimed=new Set()){const seeds=columns.filter((c)=>companySeed(c)&&!claimed.has(c.index)).sort((a,b)=>a.index-b.index);if(!seeds.length)return[];const groups=[];for(const seed of seeds){
    if(groups.some((g)=>Object.values(g.fields).some((f)=>f.index===seed.index)))continue;
    // Attach an immediately following company /company/ URL to an existing
    // company-name group instead of inventing a second company entity.
    if(seed.role==='linkedin_company'){
      const preceding=[...groups].reverse().find((g)=>
        g.fields.company && (g.seedIndex??-1)<seed.index
        && seed.index-(g.seedIndex??-1)<=3 && !g.fields.linkedin
      );
      if(preceding){putField(preceding,'linkedin',seed);continue;}
    }
    const g=makeGroup('company',seed.slotHint||groups.length+1,seed);
    putField(g,canonicalCompanyField(seed.role),seed);groups.push(g);
  }for(const c of columns){if(claimed.has(c.index))continue;const f=canonicalCompanyField(c.role);if(!f||c.role==='name'||!groups.length)continue;if(groups.some((g)=>Object.values(g.fields).some((v)=>v.index===c.index)))continue;let target=groups[0];for(const g of groups){if((g.seedIndex??-1)<=c.index)target=g;else break;}putField(target,f,c);}for(const g of groups)g.confidence=Math.min(1,.45+Object.keys(g.fields).length*.12);return groups;}
function dedicatedProviderColumn(column){return /^(?:apollo)(?:\s|$)/.test(String(column?.normalizedHeader||''));}
// A row qualifies as grouped-header context for the detected header row when
// exactly one of the two rows carries explicit POC/ordinal labels and the
// other carries plain field labels.
function groupContextRow(rows,headerRowIndex){
  const slotCells=(row)=>{let slots=0,nonEmpty=0;for(const value of row||[]){const t=String(value??'').trim();if(!t)continue;nonEmpty++;if(slotHint(t))slots++;}return{slots,nonEmpty};};
  const headerStats=slotCells(rows[headerRowIndex]);
  if(!headerStats.nonEmpty)return null;
  for(const r of [headerRowIndex-1,headerRowIndex+1]){
    if(r<0||r>=(rows||[]).length)continue;
    const stats=slotCells(rows[r]);
    if(stats.nonEmpty<2||stats.slots<2)continue;
    if(headerStats.slots>0)continue; // both rows ordinal-labelled → not a group/field pair
    return r;
  }
  return null;
}
function inferSchema(rows,options={}){
  const header=detectHeaderRow(rows,options);
  if(!header){const e=new Error('Could not infer a reliable spreadsheet header row or semantic column graph.');e.code='UNIVERSAL_SCHEMA_NOT_FOUND';throw e;}
  let columns=header.columns,effectiveHeader=rows[header.rowIndex];
  // Phase 6 — grouped / multi-row headers: when the adjacent row carries the
  // explicit POC/ordinal group labels and the detected header row carries the
  // field labels (or vice versa), the effective header is the column-wise
  // merge of both rows. Single-row headers are untouched.
  const contextRowIndex=groupContextRow(rows,header.rowIndex);
  if(contextRowIndex!==null){
    const upper=Math.min(contextRowIndex,header.rowIndex),lower=Math.max(contextRowIndex,header.rowIndex);
    const a=rows[upper]||[],b=rows[lower]||[];
    effectiveHeader=Array.from({length:Math.max(a.length,b.length)},(_,i)=>{
      const x=String(a[i]??'').trim(),y=String(b[i]??'').trim();
      return x&&y?`${x} ${y}`:(x||y);
    });
    const view=rows.slice();view[header.rowIndex]=effectiveHeader;
    columns=analyzeColumns(view,header.rowIndex);
    const raw=rows[header.rowIndex]||[];
    for(let i=0;i<columns.length;i++)columns[i].rawHeader=String(raw[i]??'').trim();
  }
  const explicitPocScope=Number(options.expectedPersonGroups||0)>0;
  // When a command explicitly targets POC groups, dedicated provider-output
  // columns such as APOLLO CONTACT/PHONE/EMAIL are evidence from another
  // workflow, not alternate ownership candidates for POC-1/POC-2.
  const graphColumns=explicitPocScope?columns.filter((column)=>!dedicatedProviderColumn(column)):columns;
  const providerSectionColumns=explicitPocScope?columns.filter(dedicatedProviderColumn).map((column)=>column.index):[];
  const personGroups=assignPersonGroups(graphColumns);
  const personIndexes=new Set(personGroups.flatMap((g)=>Object.values(g.fields).map((f)=>f.index)));
  const companyGroups=assignCompanyGroups(graphColumns,personIndexes);
  const context={};
  for(const c of graphColumns){if(personIndexes.has(c.index))continue;if(companyGroups.some((g)=>Object.values(g.fields).some((f)=>f.index===c.index)))continue;if(['details','location','source','status','notes','website','company'].includes(c.role))(context[c.role]||=[]).push({index:c.index,header:c.header,confidence:c.confidence});}
  const semantic=graphColumns.filter((c)=>c.role!=='unknown'),groupEvidence=[...personGroups,...companyGroups].reduce((s,g)=>s+g.confidence,0),confidence=Math.max(0,Math.min(1,.25+Math.min(.25,semantic.length*.025)+Math.min(.35,groupEvidence*.12)+Math.min(.15,header.score/400)));
  return{schemaVersion:1,headerRowIndex:header.rowIndex,headerRowNumber:header.rowNumber,confidence,columns,entityGroups:[...personGroups,...companyGroups],personGroups,companyGroups,contextColumns:context,providerSectionColumns,fingerprint:columns.map((c)=>normalizeHeader(c.header)).join('|'),structuralFingerprint:structuralFingerprintOf(header.rowNumber,columns)};
}

// Canonical, value-independent structural identity (Phase 8/14): header row
// plus every non-empty normalized header. Data-width padding (empty headers
// beyond the real table) and cell values can never change it.
function structuralFingerprintOf(headerRowNumber,columns){
  const parts=(Array.isArray(columns)?columns:[])
    .filter((column)=>normalizeHeader(column.header))
    .map((column)=>`${Number(column.index)}:${normalizeHeader(column.header)}`);
  return `h${Number(headerRowNumber)||0}|${parts.join('|')}`;
}
// Stable hash of the fully resolved canonical schema (frozen-schema contract).
function hashSchema(schema){
  if(!schema) return null;
  const crypto=require('crypto');
  const group=(item)=>({ordinal:item.ordinal??null,fields:Object.fromEntries(Object.entries(item.fields||{}).map(([field,descriptor])=>[field,Number(descriptor.index)]))});
  const canonical={
    headerRow:Number(schema.headerRowNumber||0),
    columns:(schema.columns||[]).map((column)=>[Number(column.index),normalizeHeader(column.header),column.role||'unknown']),
    personGroups:(schema.personGroups||[]).map(group),
    companyGroups:(schema.companyGroups||[]).map(group),
  };
  return crypto.createHash('sha1').update(JSON.stringify(canonical)).digest('hex');
}
function fieldIndex(group,field){return Number.isInteger(group?.fields?.[field]?.index)?group.fields[field].index:-1;}
module.exports={normalizeHeader,words,slotHint,extractPocIndex,semanticForHeader,structuralFingerprintOf,hashSchema,looksEmail,looksPhone,linkedInKind,looksUrl,valueSignature,headerRoleScores,bestRole,analyzeColumns,detectHeaderRow,groupContextRow,inferSchema,assignPersonGroups,assignCompanyGroups,dedicatedProviderColumn,fieldIndex};
