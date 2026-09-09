/**
 * Cline — `PreToolUse` hook script (macOS/Linux only) at ~/Documents/Cline/Hooks/PreToolUse.
 * Passthrough: {"cancel":false}. Deny: {"cancel":true,"errorMessage":"…"}.
 */
import fs from "node:fs";
import path from "node:path";
import type { AgentAdapter, InstallContext } from "./types.js";
import { DENY_MESSAGE } from "./types.js";
import { detectByDirOrBin, homePath, isObj, oneLine, str, summarizeInput } from "./util.js";
import { writeFileAtomic } from "../fsutil.js";
import { userHome } from "../paths.js";

const MARKER_LINE = "# _fitgate: managed by `fitgate init` — do not edit";

function hookScript(home: string): string {
  return homePath(home, "Documents", "Cline", "Hooks", "PreToolUse");
}

function readScript(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export const clineAdapter: AgentAdapter = {
  id: "cline",
  displayName: "Cline",
  tier: 3,
  supportsMcp: false,
  notes: "Hook scripts are macOS/Linux only. If you already have a PreToolUse script, FitGate leaves it alone.",

  async detect() {
    if (process.platform === "win32") return false;
    return detectByDirOrBin([homePath(userHome(), "Documents", "Cline"), homePath(userHome(), ".cline")], ["cline"]);
  },

  async install(ctx: InstallContext) {
    if (process.platform === "win32") throw new Error("Cline hooks are not supported on Windows");
    const file = hookScript(ctx.home);
    const existing = readScript(file);
    if (existing && !existing.includes(MARKER_LINE)) {
      throw new Error(`${file} exists and is not managed by FitGate; add \`exec ${ctx.command} gate --agent cline\` to it manually`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, `#!/bin/sh\n${MARKER_LINE}\nexec ${ctx.command} gate --agent cline\n`);
    fs.chmodSync(file, 0o755);
  },

  async uninstall(ctx: InstallContext) {
    const file = hookScript(ctx.home);
    const existing = readScript(file);
    if (existing && existing.includes(MARKER_LINE)) fs.unlinkSync(file);
  },

  async isInstalled(ctx: InstallContext) {
    const existing = readScript(hookScript(ctx.home));
    return Boolean(existing && existing.includes(MARKER_LINE));
  },

  parseStdin(json: unknown) {
    if (!isObj(json)) return {};
    const pre = isObj(json.preToolUse) ? json.preToolUse : json;
    const tool = str(pre.toolName) ?? str(pre.tool_name);
    const params = pre.parameters ?? pre.toolInput ?? pre.tool_input;
    return {
      tool: tool ? oneLine(tool, 120) : undefined,
      summary: summarizeInput(params),
      sessionId: str(json.taskId) ?? str(json.task_id),
    };
  },

  respond(outcome, message = DENY_MESSAGE) {
    if (outcome === "pass") return { stdout: JSON.stringify({ cancel: false }), exitCode: 0 };
    return { stdout: JSON.stringify({ cancel: true, errorMessage: message }), exitCode: 0 };
  },
};
