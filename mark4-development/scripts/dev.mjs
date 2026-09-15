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
const hermesNode = path.join(hermesHome, "node");

if (!fs.existsSync(vendor)) {
  console.error("Mark 4 is not bootstrapped. Run: npm run bootstrap");
  process.exit(1);
}

process.env.HERMES_HOME = hermesHome;
process.env.API_SERVER_ENABLED = "true";
process.env.API_SERVER_HOST = "127.0.0.1";
process.env.API_SERVER_PORT = "8642";
process.env.PATH = hermesNode + path.delimiter + (process.env.PATH || "");

const children = [];
let shuttingDown = false;

function run(command, args, cwd = root) {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
    shell: false
  });
  children.push(child);
  child.on("exit", code => {
    if (!shuttingDown && code && code !== 0) {
      console.error(command + " exited with code " + code);
    }
  });
  return child;
}

function runNpm(args, cwd = root) {
  if (process.platform !== "win32") return run("npm", args, cwd);
  const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
  return run(comspec, ["/d", "/s", "/c", ["npm", ...args].join(" ")], cwd);
}

async function isHealthy(url, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(url, label, timeoutMs = 60000) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) {
        console.log(label + " ready");
        return;
      }
      lastError = "HTTP " + response.status;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 450));
  }
  throw new Error(label + " did not become ready: " + lastError);
}

async function main() {
  const hermesHealth = "http://127.0.0.1:8642/health";
  if (await isHealthy(hermesHealth)) {
    console.log("Hermes already healthy; reusing existing gateway.");
  } else {
    console.log("Starting Hermes (replacing stale gateway if necessary)...");
    run("uv", ["run", "--directory", vendor, "hermes", "gateway", "run", "--replace"]);
    await waitFor(hermesHealth, "Hermes");
  }

  console.log("Starting ULTRON gateway...");
  run(process.execPath, ["services/gateway/src/server.mjs"]);
  await waitFor("http://127.0.0.1:8787/api/bootstrap", "ULTRON gateway");

  console.log("Starting cockpit...");
  runNpm(["run", "dev", "-w", "apps/ui"]);
}

function stop() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch {}
  }
  setTimeout(() => process.exit(0), 400).unref();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

main().catch(error => {
  console.error("\nULTRON startup failed:", error.message);
  stop();
});
