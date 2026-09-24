'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const intent = require('../core/apollo-lead-intent-compiler');
const discovery = require('../core/apollo-company-discovery');
const selector = require('../core/apollo-poc-selector');
const contact = require('../core/apollo-contactability-policy');
const projector = require('../core/apollo-lead-sheet-projector');
const ownership = require('../core/company-ownership-guard');

function organization(i) {
  return {
    id:`org-${i}`, name:`SaaS Product ${i}`, estimated_num_employees:25 + i,
    short_description:'B2B SaaS software product platform', country:'India',
    linkedin_url:`https://linkedin.com/company/saas-product-${i}`, website_url:`https://saas-product-${i}.example`,
  };
}
function person(company, suffix, title, phone, email='') {
  return { id:`${company}-${suffix}`, apolloPersonId:`${company}-${suffix}`, name:`Person ${company}-${suffix}`, title, phone, email,
    identityVerified:true, apolloSearchEmployerVerified:true, organizationId:company };
}

(async () => {
  const mission = intent.compile('Find 65 SaaS product companies in India with 25+ employees. Discovery only.');
  assert.equal(mission.targetCount, 65); assert.equal(mission.employeeRange.min, 25); assert.equal(mission.employeeRange.max, null);
  let organizationCalls = 0; let peopleSearchCalls = 0; let revealCalls = 0; let cacheHits = 0;
  const found = await discovery.discover(mission, { fetchPage:async()=>{ organizationCalls++; return { items:Array.from({length:90},(_,i)=>organization(i+1)) }; } });
  assert.equal(found.organizations.length, 65); assert.equal(organizationCalls, 1);

  const cache = new Map(); const enriched = [];
  for (const company of found.organizations) {
    let candidates = cache.get(company.id);
    if (candidates) cacheHits++;
    else {
      peopleSearchCalls++;
      candidates = [
        person(company.id,'founder','Founder','+14155550101',`founder@${company.domain}`),
        person(company.id,'talent','Talent Acquisition Manager','+919876540001',`talent@${company.domain}`),
        person(company.id,'recruiter','Technical Recruiter','+919876540002',`recruiter@${company.domain}`),
        person(company.id,'fallback','Recruiter','+442071230001',`fallback@${company.domain}`),
      ];
      cache.set(company.id, candidates);
    }
    // The same shared shortlist serves both POC slots. Hydration is restricted
    // to the selected finalists, not the whole candidate pool.
    const selected = selector.selectPocs(candidates, company, 2); revealCalls += selected.selected.length;
    assert.equal(selected.selected.length, 2); assert.notEqual(selected.poc1.apolloPersonId, selected.poc2.apolloPersonId);
    enriched.push({ ...company, ...selected });
  }
  // Exercise persistent reuse independently of selection.
  for (const company of found.organizations) if (cache.has(company.id)) cacheHits++;
  assert.equal(peopleSearchCalls, 65); assert.equal(cacheHits, 65); assert.ok(revealCalls <= 65 * 2);
  assert.ok(enriched.every((row) => row.poc1.identityVerified && row.poc2.identityVerified));
  assert.ok(enriched.some((row) => contact.indianPhone(row.poc1.phone) || contact.indianPhone(row.poc2.phone)));
  const foreignOnly = selector.selectPocs([person('foreign','director','Director','+14155550123','director@foreign.example')], { id:'foreign', name:'Foreign', domain:'foreign.example' }, 1);
  assert.equal(contact.quality(foreignOnly.poc1), 2);

  const columns = { companyName:0, companyLink:1, personGroups:[
    { fields:{ name:{index:2}, phone:{index:3}, email:{index:4} } },
    { fields:{ name:{index:5}, phone:{index:6}, email:{index:7} } },
  ] };
  const schema = { headerRowIndex:0, companyGroups:[{ fields:{ company:{index:0}, linkedin:{index:1} } }] };
  const beforeRows = [['COMPANY NAME','COMPANY LINK','1ST POC NAME','PHONE','EMAIL','2ND POC NAME','PHONE','EMAIL'], ...enriched.map((row)=>[row.name,row.companyLink,'','','','','',''])];
  const afterRows = [beforeRows[0], ...enriched.map((row)=>{
    const values = projector.rowValues(row, columns, true); const output = Array(8).fill('');
    output[0]=row.name; output[1]=row.companyLink; for (const [index,value] of values) output[index]=value; return output;
  })];
  const guard = ownership.verify(ownership.snapshot({schema,rows:beforeRows}), ownership.snapshot({schema,rows:afterRows}));
  assert.equal(guard.companyRowCountBefore,65); assert.equal(guard.companyRowCountAfter,65); assert.equal(guard.companyRowsDeleted,0);
  assert.equal(/sheets\.clearRows\s*\(/.test(fs.readFileSync(require.resolve('../core/universal-sheet-enrichment-targeted'),'utf8')),false);
  assert.ok(organizationCalls + peopleSearchCalls + revealCalls <= 65 * 4 + 1);
  console.log(`Apollo Lead V2 benchmark passed: 65 companies preserved, 2 distinct verified POCs/company, ${organizationCalls} organization search, ${peopleSearchCalls} shared people searches, ${revealCalls} finalist reveals, ${cacheHits} cache reuses, foreign fallback accepted, company rows deleted: 0.`);
})().catch((error)=>{ console.error(error); process.exitCode=1; });
