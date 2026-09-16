import test from "node:test";
import assert from "node:assert/strict";

process.env.ULTRON_M4_DATA_DIR = ".ultron/test-lead-dual-" + process.pid + "-" + Date.now();
const { upsertLead, getLead } = await import("../src/db.mjs");

test("lead master persists primary and secondary decision makers",()=>{
  const lead=upsertLead({
    companyName:"Dual Contact Test Pvt Ltd",
    source:"web",
    verificationStatus:"pending",
    primaryContactName:"Primary Person",
    primaryContactRole:"Founder",
    primaryPhone:"+91-111",
    primaryEmail:"primary@example.com",
    secondaryContactName:"Secondary Person",
    secondaryContactRole:"Lead Recruiter",
    secondaryPhone:"+91-222",
    secondaryEmail:"secondary@example.com"
  });
  assert.equal(lead.primaryContact.name,"Primary Person");
  assert.equal(lead.secondaryContact.name,"Secondary Person");
  assert.equal(lead.secondaryContact.role,"Lead Recruiter");
  assert.equal(getLead("Dual Contact Test Pvt Ltd").secondaryContact.email,"secondary@example.com");
});
