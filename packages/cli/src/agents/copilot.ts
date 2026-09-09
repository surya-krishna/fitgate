/**
 * GitHub Copilot CLI — `preToolUse` hook in ~/.copilot/hooks/fitgate.json.
 * Docs: https://docs.github.com/en/copilot/reference/hooks-configuration
 * A non-zero exit is fail-CLOSED, so we always exit 0 and express deny via JSON.
 */
import fs from "node:fs";
import type { AgentAdapter, InstallContext } from "./types.js";
import { DENY_MESSAGE } from "./types.js";
import { detectByDirOrBin, homePath, isObj, oneLine, str, summarizeInput } from "./util.js";
import { fileExists, writeJsonAtomic } from "../fsutil.js";
import { userHome } from "../paths.js";

function hookFile(home: string): string {
  return homePath(home, ".copilot", "hooks", "fitgate.json");
}

export const copilotAdapter: AgentAdapter = {
  id: "copilot",
  displayName: "GitHub Copilot CLI",
  tier: 1,
  supportsMcp: false,

  async detect() {
    return detectByDirOrBin([homePath(userHome(), ".copilot")], ["copilot"]);
  },

  async install(ctx: InstallContext) {
    // This file is entirely ours (Copilot reads every *.json in ~/.copilot/hooks/).
    const cmd = `${ctx.command} gate --agent copilot`;
    writeJsonAtomic(hookFile(ctx.home), {
      version: 1,
      hooks: {
        preToolUse: [{ type: "command", bash: cmd, powershell: cmd, timeoutSec: ctx.hookTimeoutSeconds, _fitgate: true }],
      },
    });
  },

  async uninstall(ctx: InstallContext) {
    try {
      fs.unlinkSync(hookFile(ctx.home));
    } catch {
      /* ignore */
    }
  },

  async isInstalled(ctx: InstallContext) {
    return fileExists(hookFile(ctx.home));
  },

  parseStdin(json: unknown) {
    if (!isObj(json)) return {};
    const tool = str(json.toolName) ?? str(json.tool_name);
    let args: unknown = json.toolArgs ?? json.tool_args ?? json.toolInput;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        /* keep as string */
      }
    }
    return {
      tool: tool ? oneLine(tool, 120) : undefined,
      summary: summarizeInput(args),
      sessionId: str(json.sessionId) ?? str(json.session_id),
    };
  },

  respond(outcome, message = DENY_MESSAGE) {
    if (outcome === "pass") return { stdout: JSON.stringify({ permissionDecision: "ask" }), exitCode: 0 };
    return { stdout: JSON.stringify({ permissionDecision: "deny", permissionDecisionReason: message }), exitCode: 0 };
  },
};
