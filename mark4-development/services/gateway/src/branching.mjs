import crypto from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mark4Root, runtimeRoot } from "./config.mjs";

const execFileAsync = promisify(execFile);

export async function createNestedBranch({ sourceSessionId, anchorMessageId = null, title = "Follow-up branch" }) {
  const vendor = path.join(runtimeRoot, "vendor", "hermes-agent");
  const helper = path.join(mark4Root, "services", "gateway", "py", "branch_session.py");
  const childSessionId = "u4_branch_" + crypto.randomUUID().replace(/-/g, "");
  const args = ["run", "--directory", vendor, "python", helper, "--source", String(sourceSessionId), "--child", childSessionId, "--title", String(title)];
  if (anchorMessageId) args.push("--anchor", String(anchorMessageId));

  const { stdout } = await execFileAsync("uv", args, {
    cwd: mark4Root,
    env: process.env,
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 1024 * 1024
  });
  const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error("BRANCH_HELPER_EMPTY_RESPONSE");
  const result = JSON.parse(lines.at(-1));
  if (!result.ok) throw new Error(result.error || "BRANCH_CREATE_FAILED");
  return result;
}
