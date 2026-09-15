import test from "node:test";
import assert from "node:assert/strict";
import { assessAction } from "../src/policy.mjs";

test("read-only work stays autonomous", () => {
  assert.deepEqual(
    assessAction({ sideEffect: "read" }),
    { allowed: true, approvalRequired: false, reason: null }
  );
});

test("external communication requires approval", () => {
  const result = assessAction({ sideEffect: "external_communication" });
  assert.equal(result.allowed, false);
  assert.equal(result.approvalRequired, true);
});

test("paid execution fails closed by default", () => {
  delete process.env.ULTRON_M4_ALLOW_PAID;
  const result = assessAction({ costClass: "paid" });
  assert.equal(result.allowed, false);
  assert.equal(result.approvalRequired, false);
});
