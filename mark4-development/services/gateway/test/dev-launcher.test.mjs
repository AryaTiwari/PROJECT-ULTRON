import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dev = fs.readFileSync(path.join(root, "scripts", "dev.mjs"), "utf8");

test("dev launcher replaces stale Hermes gateway and reloads current Mark4 config", () => {
  assert.match(dev, /gateway", "run", "--replace"/);
  assert.doesNotMatch(dev, /reusing existing gateway/);
  assert.match(dev, /hermesPython/);
  assert.match(dev, /["-m", "hermes_cli\.main", "gateway", "run", "--replace"], root/);
});
