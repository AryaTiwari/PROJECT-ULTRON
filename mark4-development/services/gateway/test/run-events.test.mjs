import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRunEvent, isTerminalRunEvent } from "../src/run-events.mjs";

test("normalizes Hermes run delta into ULTRON event",()=>{
  assert.deepEqual(normalizeRunEvent("message.delta",{delta:"x"},"run-1"),{type:"assistant.delta",data:{delta:"x",run_id:"run-1"}});
});
test("normalizes envelope event names",()=>{
  assert.equal(normalizeRunEvent("message",{event:"approval.request",request_id:"a"},"run-1").type,"approval.request");
});
test("recognizes terminal run states",()=>{
  assert.equal(isTerminalRunEvent("run.completed"),true);
  assert.equal(isTerminalRunEvent("tool.completed"),false);
});
