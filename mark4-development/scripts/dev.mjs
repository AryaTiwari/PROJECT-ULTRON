import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv(path.resolve(root, "..", ".env"));
loadEnv(path.join(root, ".env"));
loadEnv(path.join(root, ".runtime", "secrets.env"));

const vendor = path.join(root, ".runtime", "vendor", "hermes-agent");
const hermesHome = path.join(root, ".runtime", "hermes-home");

if (!fs.existsSync(vendor)) {
  console.error("Mark 4 is not bootstrapped. Run: npm run bootstrap");
  process.exit(1);
}

process.env.HERMES_HOME = hermesHome;
process.env.API_SERVER_ENABLED = "true";
process.env.API_SERVER_HOST = "127.0.0.1";
process.env.API_SERVER_PORT = "8642";

const children = [];

function run(command, args, cwd = root) {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  children.push(child);
  child.on("exit", code => {
    if (code && code !== 0) console.error(command + " exited with code " + code);
  });
  return child;
}

run("uv", ["run", "--directory", vendor, "hermes", "gateway"]);
setTimeout(() => run(process.execPath, ["services/gateway/src/server.mjs"]), 900);
setTimeout(() => run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev", "-w", "apps/ui"]), 1500);

function stop() {
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch {}
  }
  setTimeout(() => process.exit(0), 300).unref();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
