import test from "node:test";
import assert from "node:assert/strict";
import { canonicalCompanyKey, upsertLead, getLead, leadStats } from "../src/db.mjs";

test("canonical lead master deduplicates legal suffix variants",()=>{
  const stamp=Date.now();
  const a=upsertLead({companyName:`Acme Test ${stamp} Private Limited`,verificationStatus:"pending"});
  const b=upsertLead({companyName:`Acme Test ${stamp} Pvt Ltd`,location:"Mumbai",verificationStatus:"pending"});
  assert.equal(a.id,b.id);
  assert.equal(getLead(a.id).location,"Mumbai");
});

test("verified LinkedIn lead requires job evidence",()=>{
  assert.throws(()=>upsertLead({companyName:`No Evidence ${Date.now()}`,verificationStatus:"verified",source:"linkedin"}),/LINKEDIN_JOB_EVIDENCE/);
});

test("lead stats report numerical verified gap",()=>{
  const stamp=Date.now();
  upsertLead({
    companyName:`Verified ${stamp}`,
    source:"linkedin",
    verificationStatus:"verified",
    jobLink:"https://www.linkedin.com/jobs/view/123456",
    evidence:{activeJobVerified:true}
  });
  const stats=leadStats(9999);
  assert.ok(stats.verified>=1);
  assert.equal(stats.remaining,Math.max(0,9999-stats.verified));
});
