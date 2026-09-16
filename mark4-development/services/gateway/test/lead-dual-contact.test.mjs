import test from "node:test";
import assert from "node:assert/strict";

process.env.ULTRON_M4_DATA_DIR = ".ultron/test-lead-poc-" + process.pid + "-" + Date.now();
const { upsertLead, getLead } = await import("../src/db.mjs");

test("lead master persists POC1 current company plus POC2 and POC3",()=>{
  const lead=upsertLead({
    companyName:"POC Layout Test Pvt Ltd",
    source:"web",
    verificationStatus:"pending",
    primaryContactName:"First Person",
    primaryContactRole:"Technical Recruiter",
    primaryContactLinkedin:"https://www.linkedin.com/in/first-person",
    primaryContactCompany:"Current Employer Pvt Ltd",
    primaryPhone:"+91-111",
    primaryEmail:"first@example.com",
    secondaryContactName:"Second Person",
    secondaryContactRole:"Founder",
    secondaryPhone:"+91-222",
    secondaryEmail:"second@example.com",
    tertiaryContactName:"Third Person",
    tertiaryContactRole:"HR Manager",
    tertiaryPhone:"+91-333",
    tertiaryEmail:"third@example.com"
  });
  assert.equal(lead.primaryContact.company,"Current Employer Pvt Ltd");
  assert.equal(lead.secondaryContact.name,"Second Person");
  assert.equal(lead.tertiaryContact.name,"Third Person");
  assert.equal(lead.tertiaryContact.role,"HR Manager");
  assert.equal(getLead("POC Layout Test Pvt Ltd").tertiaryContact.email,"third@example.com");
});
