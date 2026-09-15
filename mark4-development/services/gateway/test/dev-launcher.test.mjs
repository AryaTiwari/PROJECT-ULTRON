import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dev = fs.readFileSync(path.join(root, "scripts", "dev.mjs"), "utf8");

test("dev launcher replaces stale Hermes gateway instead of failing on PID lock", () => {
  assert.match(dev, /gateway", "run", "--replace"/);
  assert.match(dev, /Hermes already healthy; reusing existing gateway/);
  assert.match(dev, /await isHealthy\(hermesHealth\)/);
});
