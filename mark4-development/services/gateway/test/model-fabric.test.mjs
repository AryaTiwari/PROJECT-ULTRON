import test from "node:test";
import assert from "node:assert/strict";
import { classifyModelError } from "../src/model-fabric.mjs";

test("classifies model failures for circuit breaker",()=>{
  assert.equal(classifyModelError({status:429,message:"quota"}).errorClass,"rate_limit");
  assert.equal(classifyModelError({status:401,message:"unauthorized"}).errorClass,"auth");
  assert.equal(classifyModelError({status:503,message:"unavailable"}).errorClass,"provider");
});
