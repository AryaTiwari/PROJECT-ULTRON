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

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function omniRouteSettings() {
  const baseUrl = String(process.env.OMNIROUTE_BASE_URL || "http://127.0.0.1:20128/v1").trim().replace(/\/+$/, "");
  const model = String(process.env.ULTRON_OMNIROUTE_DEFAULT_MODEL || "auto/best-reasoning").trim() || "auto/best-reasoning";
  const testModel = String(process.env.ULTRON_OMNIROUTE_TEST_MODEL || "auto/best-fast").trim() || "auto/best-fast";
  const apiKey = String(process.env.OMNIROUTE_API_KEY || process.env.OMNIROUTE_ENDPOINT_KEY || process.env.ULTRON_OMNIROUTE_API_KEY || "").trim();
  if (apiKey && !process.env.OMNIROUTE_API_KEY) process.env.OMNIROUTE_API_KEY = apiKey;
  return {
    baseUrl,
    model,
    testModel,
    apiKey,
    configured: Boolean(apiKey || process.env.OMNIROUTE_DIR),
    testMode: truthy(process.env.ULTRON_M4_OMNIROUTE_TEST)
  };
}

const omniRoute = omniRouteSettings();

function configureModelRoutes() {
  if (omniRoute.testMode) {
    const directInferenceKeys = [
      "GOOGLE_API_KEY",
      "GEMINI_API_KEY",
      "NVIDIA_API_KEY",
      "XAI_API_KEY",
      "GROQ_API_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "DEEPSEEK_API_KEY",
      "MISTRAL_API_KEY",
      "OPENROUTER_API_KEY"
    ];
    const masked = directInferenceKeys.filter(key => Boolean(process.env[key]));
    for (const key of masked) delete process.env[key];

    for (const role of ["COGNITION","WORKER","VERIFIER","CREATIVE"]) {
      process.env[`ULTRON_M4_${role}_PROVIDER`] = "omniroute";
      process.env[`ULTRON_M4_${role}_MODEL`] = omniRoute.testModel;
    }
    process.env.ULTRON_M4_OMNIROUTE_MASKED_KEYS = masked.join(",");

    return {
      provider: "omniroute",
      model: omniRoute.testModel,
      source: "OmniRoute isolated test mode",
      maskedDirectKeys: masked
    };
  }
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

function yamlQuote(value) {
  return JSON.stringify(String(value || ""));
}

function syncHermesRuntimeConfig() {
  const configPath = path.join(hermesHome, "config.yaml");
  const capability = path.join(root, "services", "capability-host", "src", "server.mjs").replaceAll("\\", "/");
  const projectPath = root.replaceAll("\\", "/");
  const primaryProvider = selectedModelRoute.provider || "auto";
  const primaryModel = selectedModelRoute.model || "";

  const fallbacks = [];
  const addFallback = (provider, model, extra = {}) => {
    provider = String(provider || "").trim();
    model = String(model || "").trim();
    if (!provider || !model) return;
    if (provider === primaryProvider && model === primaryModel && !extra.baseUrl) return;
    if (fallbacks.some(x => x.provider === provider && x.model === model && (x.baseUrl || "") === (extra.baseUrl || ""))) return;
    fallbacks.push({ provider, model, ...extra });
  };

  if (omniRoute.testMode) {
    // Hermes can activate only one cross-provider fallback per turn in the pinned runtime.
    // Keep OmniRoute itself as the router and reserve one alternate alias as the rescue route.
    addFallback("custom", "auto/best-reasoning", { baseUrl: omniRoute.baseUrl, keyEnv: "OMNIROUTE_API_KEY" });
  } else {
    if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) {
      addFallback("gemini", "gemini-3.7-flash");
      addFallback("gemini", "gemini-3.6-flash");
    }
    if (process.env.NVIDIA_API_KEY) {
      addFallback("nvidia", String(process.env.ULTRON_M4_NVIDIA_MODEL || "nvidia/nemotron-3-super-120b-a12b"));
    }
    addFallback("custom", omniRoute.model, { baseUrl: omniRoute.baseUrl, keyEnv: "OMNIROUTE_API_KEY" });
  }

  const fallbackYaml = fallbacks.length
    ? "fallback_providers:\n" + fallbacks.map(x => {
        const lines = [`  - provider: ${yamlQuote(x.provider)}`, `    model: ${yamlQuote(x.model)}`];
        if (x.baseUrl) lines.push(`    base_url: ${yamlQuote(x.baseUrl)}`);
        if (x.keyEnv) lines.push(`    key_env: ${yamlQuote(x.keyEnv)}`);
        return lines.join("\n");
      }).join("\n")
    : "fallback_providers: []";

  const omniContext = Math.max(32768, Number(process.env.ULTRON_OMNIROUTE_CONTEXT_LENGTH || 131072));
  const modelYaml = primaryModel
    ? `model:\n  provider: ${yamlQuote(primaryProvider)}\n  default: ${yamlQuote(primaryModel)}${primaryProvider === "omniroute" ? `\n  context_length: ${omniContext}` : ""}`
    : 'model:\n  provider: "auto"';

  const omniRouteProviderYaml = `providers:
  omniroute:
    name: "OmniRoute"
    base_url: ${yamlQuote(omniRoute.baseUrl)}
    key_env: "OMNIROUTE_API_KEY"
    default_model: ${yamlQuote(omniRoute.model)}
    transport: "chat_completions"
    enabled: true`;

  const configText = `${modelYaml}

${omniRouteProviderYaml}

agent:
  api_max_retries: 1

${fallbackYaml}

terminal:
  backend: local
  cwd: ${yamlQuote(projectPath)}

browser:
  engine: auto
  headed: false
  record_sessions: false

gateway:
  api_server:
    enabled: true
    host: "127.0.0.1"
    port: 8642
    max_concurrent_runs: 2

auxiliary:
  vision:
    provider: main
    max_concurrency: 2
  approval:
    provider: main
  compression:
    provider: main
    max_concurrency: 1
  mcp:
    provider: main
  skills_hub:
    provider: main
  title_generation:
    enabled: false
    provider: main

mcp_servers:
  ultron:
    command: "node"
    args:
      - ${yamlQuote(capability)}
    trust: "full"
    timeout: 180
    connect_timeout: 20
    supports_parallel_tool_calls: false
`;
  fs.writeFileSync(configPath, configText, "utf8");
  return { configPath, fallbacks };
}

const runtimeModelPolicy = syncHermesRuntimeConfig();

async function probeOmniRoute() {
  if (!omniRoute.testMode) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const headers = { Accept: "application/json" };
    if (omniRoute.apiKey) headers.Authorization = "Bearer " + omniRoute.apiKey;
    const response = await fetch(omniRoute.baseUrl + "/models", { headers, signal: controller.signal, cache: "no-store" });
    const raw = await response.text();
    if (!response.ok) throw new Error("OmniRoute /models HTTP " + response.status + ": " + raw.slice(0, 500));
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch {}
    const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    console.log("OmniRoute preflight ready:", omniRoute.baseUrl, "| models:", rows.length || "catalog available");
    return { ok: true, models: rows.length };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("OmniRoute preflight timed out at " + omniRoute.baseUrl + "/models");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const children = [];
let shuttingDown = false;

function run(command, args, cwd = root) {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
    shell: false,
    windowsHide: process.platform === "win32"
  });
  children.push(child);
  child.on("exit", code => {
    if (!shuttingDown && code && code !== 0) {
      console.error(command + " exited with code " + code);
    }
  });
  return child;
}

function resolveViteCli() {
  const candidates = [
    path.join(root,"node_modules","vite","bin","vite.js"),
    path.join(root,"apps","ui","node_modules","vite","bin","vite.js")
  ];
  return candidates.find(file=>fs.existsSync(file)) || "";
}

function runVite() {
  const viteCli=resolveViteCli();
  if(!viteCli)throw new Error("Vite CLI not found. Run npm install.");
  return run(process.execPath,[viteCli,"--host","127.0.0.1","--port","5174"],path.join(root,"apps","ui"));
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1800);
    try {
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      if (response.ok) {
        console.log(label + " ready");
        return;
      }
      lastError = "HTTP " + response.status;
    } catch (error) {
      lastError = error?.name === "AbortError" ? "request timeout" : (error?.message || String(error));
    } finally {
      clearTimeout(timer);
    }
    await new Promise(resolve => setTimeout(resolve, 300));
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
    const child=spawn(executable,["--headless=new","--disable-gpu","--no-first-run","--disable-extensions","--user-data-dir="+profile,"--virtual-time-budget=4000","--dump-dom",url],{cwd:root,env:process.env,stdio:["ignore","pipe","pipe"],shell:false,windowsHide:process.platform==="win32"});
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
  if (omniRoute.testMode) {
    console.log("OMNIROUTE TEST MODE ACTIVE: all direct model routes are disabled for this ULTRON run.");
    console.log("OmniRoute route:", omniRoute.baseUrl, "| model:", omniRoute.testModel);
    const masked = String(process.env.ULTRON_M4_OMNIROUTE_MASKED_KEYS || "").split(",").filter(Boolean);
    console.log("Direct inference keys masked from Hermes:", masked.length ? masked.join(", ") : "none detected");
    console.log("All Mark 4 cognitive roles forced to omniroute/" + omniRoute.testModel + ".");
    console.log("OmniRoute-only routing: " + omniRoute.testModel + " with one Hermes rescue to auto/best-reasoning.");
    if (!truthy(process.env.ULTRON_M4_OMNIROUTE_READY)) await probeOmniRoute();
  }
  console.log("Starting Hermes with a fresh Mark 4 runtime...");
  run(hermesPython, ["-m", "hermes_cli.main", "gateway", "run", "--replace"], root);
  await waitFor(hermesHealth, "Hermes");

  if (selectedModelRoute.provider) {
    console.log("Model route:", selectedModelRoute.provider + " / " + selectedModelRoute.model + " (" + selectedModelRoute.source + ")");
    if (runtimeModelPolicy.fallbacks.length) {
      console.log("Fallback chain:", runtimeModelPolicy.fallbacks.map(x => x.provider + "/" + x.model).join(" -> "));
    }
  } else {
    console.warn("No primary model credential detected. Add Gemini/NVIDIA credentials, explicit ULTRON_M4 cognition routing, or start OmniRoute.");
  }

  console.log("Starting ULTRON gateway...");
  run(process.execPath, ["services/gateway/src/server.mjs"]);
  await waitFor("http://127.0.0.1:8787/api/ready", "ULTRON deep readiness");

  console.log("Starting cockpit...");
  runVite();
  await waitFor("http://127.0.0.1:5174/", "Vite cockpit");
  if (String(process.env.ULTRON_M4_UI_SMOKE || "0") === "1") {
    try {
      await verifyBrowserMount();
      console.log("ULTRON cockpit painted successfully.");
    } catch (error) {
      console.warn("UI paint smoke warning:", error?.message || String(error));
      console.warn("Cockpit remains running. The built-in fatal overlay will show any real React crash.");
    }
  } else {
    console.log("Cockpit ready. Browser smoke probe skipped (set ULTRON_M4_UI_SMOKE=1 to enable).");
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
