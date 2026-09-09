/**
 * Cursor — `beforeShellExecution` + `beforeMCPExecution` hooks in ~/.cursor/hooks.json.
 * Docs: https://cursor.com/docs/agent/hooks
 * Passthrough: {"permission":"ask",...}. Deny: {"permission":"deny",...}.
 */
import type { AgentAdapter, InstallContext } from "./types.js";
import { DENY_MESSAGE, PASS_MESSAGE } from "./types.js";
import { asArray, detectByDirOrBin, editJsonFile, ensureObj, hasMarked, homePath, isObj, oneLine, pruneEmpty, readJsonSafe, removeMarked, str, upsertMarked } from "./util.js";
import { userHome } from "../paths.js";

const EVENTS = ["beforeShellExecution", "beforeMCPExecution"];

function hooksPath(home: string): string {
  return homePath(home, ".cursor", "hooks.json");
}

export const cursorAdapter: AgentAdapter = {
  id: "cursor",
  displayName: "Cursor",
  tier: 1,
  supportsMcp: true,
  notes: "failClosed:false keeps FitGate fail-open. Restart Cursor after installing.",

  async detect() {
    return detectByDirOrBin([homePath(userHome(), ".cursor")], ["cursor", "cursor-agent"]);
  },

  async install(ctx: InstallContext) {
    editJsonFile(hooksPath(ctx.home), (cfg) => {
      if (typeof cfg.version !== "number") cfg.version = 1;
      const hooks = ensureObj(cfg, "hooks");
      for (const ev of EVENTS) {
        hooks[ev] = upsertMarked(asArray(hooks[ev]), {
          command: `${ctx.command} gate --agent cursor`,
          timeout: ctx.hookTimeoutSeconds,
          failClosed: false,
        });
      }
    });
  },

  async uninstall(ctx: InstallContext) {
    const cfg = readJsonSafe(hooksPath(ctx.home));
    if (!isObj(cfg.hooks)) return;
    editJsonFile(hooksPath(ctx.home), (c) => {
      const hooks = ensureObj(c, "hooks");
      for (const ev of EVENTS) {
        if (!Array.isArray(hooks[ev])) continue;
        hooks[ev] = removeMarked(asArray(hooks[ev]));
        pruneEmpty(hooks, ev);
      }
    });
  },

  async isInstalled(ctx: InstallContext) {
    const cfg = readJsonSafe(hooksPath(ctx.home));
    return isObj(cfg.hooks) && hasMarked(asArray(cfg.hooks.beforeShellExecution));
  },

  parseStdin(json: unknown) {
    if (!isObj(json)) return {};
    const command = str(json.command);
    const toolName = str(json.tool_name);
    const server = str(json.mcp_server_name);
    const sessionId = str(json.conversation_id) ?? str(json.generation_id);
    if (command) {
      return { tool: "shell", summary: oneLine(command), sessionId };
    }
    if (toolName) {
      const tool = server ? `mcp__${server}__${toolName}` : toolName;
      return { tool: oneLine(tool, 120), summary: oneLine(server ? `${server}: ${toolName}` : toolName), sessionId };
    }
    return { sessionId };
  },

  respond(outcome, message) {
    if (outcome === "pass") {
      return { stdout: JSON.stringify({ permission: "ask", user_message: message ?? PASS_MESSAGE }), exitCode: 0 };
    }
    const msg = message ?? DENY_MESSAGE;
    return { stdout: JSON.stringify({ permission: "deny", user_message: msg, agent_message: msg }), exitCode: 0 };
  },
};
