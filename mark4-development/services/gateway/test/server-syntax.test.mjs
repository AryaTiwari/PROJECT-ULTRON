import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../src/server.mjs", import.meta.url));

test("gateway entrypoint parses as valid JavaScript", () => {
  const result = spawnSync(process.execPath, ["--check", serverPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
