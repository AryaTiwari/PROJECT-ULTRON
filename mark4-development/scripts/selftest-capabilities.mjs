import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, [path.join(root, "services/capability-host/src/server.mjs")], {
  stdio: ["pipe", "pipe", "inherit"]
});

let buffer = "";
const pending = new Map();

child.stdout.setEncoding("utf8");
child.stdout.on("data", chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) {
      resolve(message);
      pending.delete(message.id);
    }
  }
});

function call(id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MCP timeout")), 3000);
    pending.set(id, message => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

try {
  const initialized = await call(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "ultron-selftest", version: "1" }
  });
  assert.equal(initialized.result.serverInfo.name, "ultron-mark4");

  const listed = await call(2, "tools/list");
  const names = listed.result.tools.map(tool => tool.name);
  for (const required of [
    "ultron_status",
    "ultron_mission_create",
    "ultron_mission_update",
    "ultron_record_evidence",
    "ultron_apollo_find_company_contact"
  ]) {
    assert.ok(names.includes(required), required);
  }

  console.log("capability-host: PASS (" + names.length + " tools)");
} finally {
  child.kill();
}
