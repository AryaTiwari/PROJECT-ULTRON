import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const mark4Root = path.resolve(here, "../../..");
export const repoRoot = path.resolve(mark4Root, "..");
export const runtimeRoot = path.join(mark4Root, ".runtime");
export const dataRoot = path.join(mark4Root, ".ultron");
export const uiDist = path.join(mark4Root, "apps", "ui", "dist");

export const config = Object.freeze({
  host: "127.0.0.1",
  port: Number(process.env.ULTRON_M4_PORT || 8787),
  hermesUrl: String(process.env.ULTRON_M4_HERMES_URL || "http://127.0.0.1:8642").replace(/\/$/, ""),
  hermesKey: String(process.env.ULTRON_M4_HERMES_API_KEY || ""),
  internalKey: String(process.env.ULTRON_M4_INTERNAL_KEY || ""),
  sessionKey: String(process.env.ULTRON_M4_SESSION_KEY || "ultron:arya:desktop"),
  allowLegacy: String(process.env.ULTRON_M4_ALLOW_LEGACY || "0") === "1",
});
