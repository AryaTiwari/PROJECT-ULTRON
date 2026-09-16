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
const hermesPython = process.platform === "win32"
  ? path.join(vendor, ".venv", "Scripts", "python.exe")
  : path.join(vendor, ".venv", "bin", "python");

if (!fs.existsSync(vendor) || !fs.existsSync(hermesPython)) {
  console.error("Mark 4 is not bootstrapped correctly. Run: npm run bootstrap");
  process.exit(1);
}

process.env.HERMES_HOME = hermesHome;
process.env.API_SERVER_ENABLED = "true";
process.env.API_SERVER_HOST = "127.0.0.1";
process.env.API_SERVER_PORT = "8642";
process.env.PATH = hermesNode + path.delimiter + (process.env.PATH || "");
process.env.TERMINAL_CWD = root;

function configureModelRoutes() {
  const explicitProvider = String(process.env.ULTRON_M4_COGNITION_PROVIDER || "").trim();
  const explicitModel = String(process.env.ULTRON_M4_COGNITION_MODEL || "").trim();
  if (explicitProvider && explicitModel) return { provider: explicitProvider, model: explicitModel, source: "explicit" };

  let provider = "", model = "", source = "";
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) {
    provider = "gemini";
    model = String(process.env.ULTRON_M4_GEMINI_MODEL || "gemini-3.8-flash");
    source = "Google AI Studio";
  } else if (process.env.NVIDIA_API_KEY) {
    provider = "nvidia";
    model = String(process.env.ULTRON_M4_NVIDIA_MODEL || "nvidia/nemotron-3-super-120b-a12b");
    source = "NVIDIA NIM";
  }

  if (provider && model) {
    process.env.ULTRON_M4_COGNITION_PROVIDER = provider;
    process.env.ULTRON_M4_COGNITION_MODEL = model;
    process.env.ULTRON_M4_WORKER_PROVIDER ||= provider;
    process.env.ULTRON_M4_WORKER_MODEL ||= model;
    process.env.ULTRON_M4_VERIFIER_PROVIDER ||= provider;
    process.env.ULTRON_M4_VERIFIER_MODEL ||= model;
    process.env.ULTRON_M4_CREATIVE_PROVIDER ||= provider;
    process.env.ULTRON_M4_CREATIVE_MODEL ||= model;
  }
  return { provider, model, source };
}

const selectedModelRoute = configureModelRoutes();

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

function browserCandidates(){
  const pf=process.env.ProgramFiles||"C:\\Program Files";
  const pfx86=process.env["ProgramFiles(x86)"]||"C:\\Program Files (x86)";
  const local=process.env.LOCALAPPDATA||"";
  return [
    local&&path.join(local,"Google","Chrome","Application","chrome.exe"),
    path.join(pf,"Google","Chrome","Application","chrome.exe"),
    path.join(pfx86,"Google","Chrome","Application","chrome.exe"),
    path.join(pf,"Microsoft","Edge","Application","msedge.exe"),
    path.join(pfx86,"Microsoft","Edge","Application","msedge.exe")
  ].filter(Boolean).filter(file=>fs.existsSync(file));
}

function dumpDom(executable,url,timeoutMs=15000){
  return new Promise((resolve,reject)=>{
    const profile=path.join(root,".runtime","ui-smoke-profile");
    fs.mkdirSync(profile,{recursive:true});
    const child=spawn(executable,["--headless=new","--disable-gpu","--no-first-run","--disable-extensions","--user-data-dir="+profile,"--virtual-time-budget=4000","--dump-dom",url],{cwd:root,env:process.env,stdio:["ignore","pipe","pipe"],shell:false});
    let stdout="",stderr="";const timer=setTimeout(()=>{try{child.kill();}catch{}reject(new Error("browser smoke timeout"));},timeoutMs);
    child.stdout.on("data",chunk=>stdout+=chunk.toString());
    child.stderr.on("data",chunk=>stderr+=chunk.toString());
    child.on("error",error=>{clearTimeout(timer);reject(error);});
    child.on("exit",code=>{clearTimeout(timer);if(code===0)resolve(stdout);else reject(new Error("browser smoke exited "+code+": "+stderr.slice(-1200)));});
  });
}

async function verifyBrowserMount(){
  const browser=browserCandidates()[0];
  if(!browser){console.warn("No Chrome/Edge found for UI paint smoke test; continuing after HTTP readiness.");return;}
  const dom=String(await dumpDom(browser,"http://127.0.0.1:5174/?ultron-smoke="+Date.now()));
  if(/id="ultron-fatal"[^>]*class="[^"]*visible/.test(dom))throw new Error("Frontend runtime crash detected by browser smoke test.");
  if(!dom.includes('class="u4-shell"'))throw new Error("Frontend did not mount .u4-shell. Browser DOM: "+dom.slice(0,900));
}

async function main() {
  const hermesHealth = "http://127.0.0.1:8642/health";
  console.log("Starting Hermes with a fresh Mark 4 runtime...");
  run(hermesPython, ["-m", "hermes_cli.main", "gateway", "run", "--replace"], root);
  await waitFor(hermesHealth, "Hermes");

  if (selectedModelRoute.provider) {
    console.log("Model route:", selectedModelRoute.provider + " / " + selectedModelRoute.model + " (" + selectedModelRoute.source + ")");
  } else {
    console.warn("No explicit free model credential detected. Add GEMINI_API_KEY/GOOGLE_API_KEY, NVIDIA_API_KEY, or ULTRON_M4_COGNITION_PROVIDER + ULTRON_M4_COGNITION_MODEL.");
  }

  console.log("Starting ULTRON gateway...");
  run(process.execPath, ["services/gateway/src/server.mjs"]);
  await waitFor("http://127.0.0.1:8787/api/ready", "ULTRON deep readiness");

  console.log("Starting cockpit...");
  runNpm(["run", "dev", "-w", "apps/ui"]);
  await waitFor("http://127.0.0.1:5174/", "Vite cockpit");
  try {
    await verifyBrowserMount();
    console.log("ULTRON cockpit painted successfully.");
  } catch (error) {
    console.warn("UI paint smoke warning:", error?.message || String(error));
    console.warn("Cockpit remains running. Open http://127.0.0.1:5174/ and the built-in fatal overlay will show any real React crash.");
  }
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
