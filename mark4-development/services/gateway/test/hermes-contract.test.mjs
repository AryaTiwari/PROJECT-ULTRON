import test from "node:test";
import assert from "node:assert/strict";
import { unwrapList, unwrapSession } from "../src/hermes-contract.mjs";

test("Hermes list wrappers normalize to arrays",()=>{
  assert.deepEqual(unwrapList({data:[{id:"a"}]}),[{id:"a"}]);
  assert.deepEqual(unwrapList({sessions:[{id:"b"}]}),[{id:"b"}]);
  assert.deepEqual(unwrapList([{id:"c"}]),[{id:"c"}]);
});
test("Hermes create wrapper normalizes to session object",()=>{
  assert.deepEqual(unwrapSession({object:"hermes.session",session:{id:"x"}}),{id:"x"});
  assert.deepEqual(unwrapSession({id:"y"}),{id:"y"});
});
