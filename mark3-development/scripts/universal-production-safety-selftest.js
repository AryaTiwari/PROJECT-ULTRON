'use strict';
const assert = require('assert/strict');
const contact = require('../core/universal-contact-normalization');
const planner = require('../core/universal-enrichment-planner');
const policy = require('../core/universal-orphan-contact-policy');
const schema = require('../core/universal-sheet-schema');
const safety = require('../core/universal-schema-safety');
const sheets = require('../core/google-sheets-operator');
sheets.batchValues=async(id,ranges)=>Promise.all(ranges.map(range=>sheets.values(id,range)));
const guard = require('../core/universal-live-write-guard');

async function main() {
  for (const identity of ['Rahul Sharma','Rahul Sharma — HR Manager','Rahul Sharma - HR Manager','Rahul Sharma | HR Manager','Rahul Sharma (HR Manager)','Rahul Sharma, HR Manager','Rahul Sharma – Talent Acquisition']) {
    assert.equal(contact.splitIdentity(identity).name, 'Rahul Sharma');
    assert.ok(planner.samePerson({name:identity}, {name:'Rahul Sharma'}));
  }
  assert.equal(contact.splitIdentity('Anne-Marie Smith').name, 'Anne-Marie Smith');
  for (const email of ['rahul@company.com','Email: rahul@company.com','Work Email - rahul@company.com','rahul@company.com (official)']) assert.equal(contact.normalizeEmail(email), 'rahul@company.com');
  assert.equal(contact.normalizeEmail('a@x.com or b@x.com'), '');
  for (const phone of ['9876543210','+91 98765 43210','+919876543210','91-9876543210','09876543210','(033) 1234 5678','+1 415 555 1212']) assert.ok(contact.phone(phone));
  assert.ok(contact.equivalentPhone('+91 98765 43210','91-9876543210'));
  assert.ok(!contact.equivalentPhone('+91 98765 43210','+1 98765 43210'));
  assert.ok(!contact.equivalentPhone('9876543210','+919876543210'));
  assert.ok(!policy.verify({email:'not an email'}, {email:'a@x.com'}).verified);
  assert.ok(!policy.verify({email:'a@x.com',phone:'garbage'}, {email:'a@x.com',phone:'1234567890'}).verified);
  for (const headers of [['Company','Name','Phone','Email'], ['Company','Name','Email','Phone'], ['Company','LinkedIn','Name','Email','Phone'], ['Company','Name','Designation','LinkedIn','Email','Mobile']]) {
    const inferred=schema.inferSchema([headers, headers.map((h)=>h==='Company'?'Acme':h==='Name'?'Rahul Sharma':'')]);
    const group=inferred.personGroups[0];
    assert.ok(group);
    for (const [field,header] of [['name','Name'],['email','Email'],['phone',headers.includes('Phone')?'Phone':'Mobile']]) assert.equal(group.fields[field].index,headers.indexOf(header));
    const writes=planner.safeWritesForGroup(headers.map(()=>''),group,{name:'Rahul Sharma',title:'HR Manager'}).writes;
    assert.equal(writes.find(w=>w.field==='name').value,headers.includes('Designation')?'Rahul Sharma':'Rahul Sharma — HR Manager');
  }
  const group={id:'p1',kind:'person',ordinal:1,fields:{name:{index:1,header:'Name'},phone:{index:2,header:'Phone'},email:{index:3,header:'Email'}}};
  assert.ok(!planner.safeWritesForGroup(['Acme','','','other@acme.com'],group,{name:'Rahul Sharma',email:'rahul@acme.com'}).allowed);
  assert.ok(!planner.safeWritesForGroup(['Acme','Existing Person','',''],group,{name:'Rahul Sharma',phone:'1234567890'}).allowed);
  assert.ok(!safety.assess({confidence:.9,personGroups:[{...group,alternates:[{field:'phone',index:4,header:'Number',confidence:.9}],fields:{...group.fields,phone:{...group.fields.phone,confidence:.9}}}]}).safe);

  const headers=['Company','Name','Phone','Email'];
  const row=['Acme','Rahul Sharma','',''];
  const source={spreadsheetId:'offline',sheetName:'Leads',rows:[headers,row],schema:{headerRowNumber:1,columns:headers.map((header,index)=>({header,index}))}};
  let liveRow=row.slice(), liveHeader=headers.slice(), writes=0;
  const originalValues=sheets.values, originalWrite=sheets.writeCells;
  sheets.values=async (_id,range)=>[range.endsWith('1:1')?liveHeader:liveRow];
  sheets.writeCells=async (_id,changes)=>{writes++;assert.equal(changes.length,2);return {updatedCells:2};};
  const changes=[{range:"'Leads'!C2",value:'+919876543210'},{range:"'Leads'!D2",value:'rahul@acme.com'}];
  try {
    await guard.writeVerifiedRow(source,2,row,changes); assert.equal(writes,1);
    for(const [column,value] of [[0,'Other company'],[1,'Other person'],[2,'existing phone'],[3,'existing@email.com']]) {
      liveRow=row.slice();liveRow[column]=value;
      await assert.rejects(guard.writeVerifiedRow(source,2,row,changes),e=>e.code==='UNIVERSAL_LIVE_WRITE_CONFLICT');
      assert.equal(writes,1);
    }
    liveRow=row.slice();liveHeader=['Company','Email','Phone','Name'];
    await assert.rejects(guard.writeVerifiedRow(source,2,row,changes),e=>e.reason==='schema-changed');
    assert.equal(writes,1);
  } finally {sheets.values=originalValues;sheets.writeCells=originalWrite;}
  // The final audit must inspect every requested slot, not just POC-2.
  const base=require('../core/universal-sheet-enrichment-operator');
  const targeted=require('../core/universal-sheet-enrichment-targeted');
  const identities=base.rememberCandidate({}, {name:'One Person',email:'one@acme.com',phone:'+919876543210',id:'apollo-1'});
  assert.ok(base.candidateAlreadyPresent({name:'Different Spelling',email:'Email: one@acme.com'},identities));
  assert.ok(base.candidateAlreadyPresent({name:'Different Spelling',phone:'+91 98765 43210'},identities));
  assert.ok(base.candidateAlreadyPresent({name:'Different Spelling',id:'apollo-1'},identities));
  const originalPendingValues=sheets.values;
  const pendingItem={rowNumber:2,columnIndex:2,personName:'Rahul Sharma',ownerFields:group.fields};
  sheets.values=async (_id,range)=>[range.endsWith('1:1')?headers:['Acme','Rahul Sharma','','']];
  try {
    assert.equal(await base.pendingOwnerCell(source,pendingItem),'');
    sheets.values=async (_id,range)=>[range.endsWith('1:1')?headers:['Acme','Other Person','','']];
    await assert.rejects(base.pendingOwnerCell(source,pendingItem),e=>e.code==='UNIVERSAL_LIVE_WRITE_CONFLICT');
    await assert.rejects(base.pendingOwnerCell(source,{...pendingItem,ownerFields:null}),e=>e.code==='UNIVERSAL_LIVE_WRITE_CONFLICT');
    sheets.values=async()=>{throw new Error('Google auth expired');};
    await assert.rejects(base.pendingOwnerCell(source,pendingItem),/auth expired/);
  } finally {sheets.values=originalPendingValues;}
  const originalRead=base.readUniversalSheet;
  const rows=[['Company','POC 1','Phone 1','Email 1','POC 2','Phone 2','Email 2','POC 3','Phone 3','Email 3'],['Acme','One Person','1111111111','one@acme.com','Two Person','2222222222','two@acme.com','','','']];
  base.readUniversalSheet=async()=>({rows,schema:schema.inferSchema(rows)});
  try {
    let audit=await targeted.mandatoryCompletionAudit({sheetUrl:'offline'}, {expectedPersonGroups:3});
    assert.equal(audit.complete,false);
    assert.ok(audit.requiredIdentityIssues.some(i=>i.groupOrdinal===3));
    rows[1][7]='Three Person';
    audit=await targeted.mandatoryCompletionAudit({sheetUrl:'offline'}, {expectedPersonGroups:3});
    assert.equal(audit.requiredIdentityIssues.length,0);
    assert.equal(audit.contactGaps.length,2);
  } finally {base.readUniversalSheet=originalRead;}
  console.log('Universal production safety regressions passed: identity parsing, layouts, contact normalization, orphan preservation, live row/header conflicts, batch writes, and requested POC-3 auditing.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
