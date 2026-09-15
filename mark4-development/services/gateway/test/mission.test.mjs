import test from "node:test";
import assert from "node:assert/strict";
import {
  createMission,
  getMission,
  updateMission,
  addEvidence,
  listEvidence
} from "../src/db.mjs";

test("mission state keeps measurable progress and evidence", () => {
  const mission = createMission({
    objective: "selftest-" + Date.now(),
    state: { current: 2, target: 5 },
    completionCriteria: { target: 5 }
  });

  updateMission(mission.id, {
    state: { current: 3 },
    nextAction: "continue"
  });

  const after = getMission(mission.id);
  assert.equal(after.state.current, 3);
  assert.equal(after.state.target, 5);
  assert.equal(after.nextAction, "continue");

  addEvidence({
    missionId: mission.id,
    kind: "receipt",
    source: "selftest",
    ref: "test:1",
    verified: true
  });

  const evidence = listEvidence(mission.id);
  assert.equal(evidence[0].verified, true);
  assert.equal(evidence[0].ref, "test:1");
});
