import process from "node:process";

await import("./ensure-omniroute.mjs");
process.env.ULTRON_M4_OMNIROUTE_READY="1";
process.env.ULTRON_M4_OMNIROUTE_TEST="1";
console.log("Launching isolated OmniRoute cognition test. Direct Gemini/NVIDIA/Grok routes will be masked inside Mark 4.");
await import("./dev.mjs");
