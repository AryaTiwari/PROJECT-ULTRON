import test from "node:test";
import assert from "node:assert/strict";
import { canonicalCreatorKey,upsertCreator,getCreator,creatorStats } from "../src/db.mjs";

test("creator registry deduplicates Instagram handle forms",()=>{
  const stamp=String(Date.now()).slice(-8),handle="u4creator"+stamp;
  const a=upsertCreator({platform:"instagram",handle:"@"+handle,qualificationStatus:"candidate"});
  const b=upsertCreator({platform:"instagram",handle:"https://www.instagram.com/"+handle+"/",displayName:"Test Creator",qualificationStatus:"candidate"});
  assert.equal(a.id,b.id);assert.equal(canonicalCreatorKey("instagram","@"+handle),"instagram:"+handle);assert.equal(getCreator(a.id).displayName,"Test Creator");
});
test("creator metrics cannot be fabricated into storage",()=>{
  assert.throws(()=>upsertCreator({handle:"metricguard"+Date.now(),followerCount:12000,evidence:{profileObserved:true}}),/METRIC_REQUIRES_OBSERVED_EVIDENCE/);
});
test("qualified creator requires inspected profile evidence",()=>{
  assert.throws(()=>upsertCreator({handle:"qualguard"+Date.now(),qualificationStatus:"qualified"}),/QUALIFICATION_REQUIRES_PROFILE_EVIDENCE/);
});
test("creator target gap reads authoritative registry",()=>{
  const handle="qualified"+Date.now();upsertCreator({handle,qualificationStatus:"qualified",evidence:{profileObserved:true}});
  const stats=creatorStats(9999);assert.ok(stats.qualified>=1);assert.equal(stats.remaining,Math.max(0,9999-stats.qualified));
});
