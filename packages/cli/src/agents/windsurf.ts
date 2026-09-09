/**
 * Windsurf / Devin Desktop — `pre_run_command`, `pre_mcp_tool_use`, `pre_write_code`
 * in ~/.codeium/windsurf/hooks.json. Exit 0 = proceed, exit 2 = block.
 * Docs: https://docs.devin.ai/desktop/cascade/hooks
 */
import type { AgentAdapter, InstallContext } from "./types.js";
import { asArray, detectByDirOrBin, editJsonFile, ensureObj, hasMarked, homePath, isObj, oneLine, pruneEmpty, readJsonSafe, removeMarked, str, summarizeInput, upsertMarked } from "./util.js";
import { userHome } from "../paths.js";

const EVENTS = ["pre_run_command", "pre_mcp_tool_use", "pre_write_code"];

function hooksPath(home: string): string {
  return homePath(home, ".codeium", "windsurf", "hooks.json");
}

export const windsurfAdapter: AgentAdapter = {
  id: "windsurf",
  displayName: "Windsurf (Devin Desktop)",
  tier: 2,
  supportsMcp: true,

  async detect() {
    return detectByDirOrBin([homePath(userHome(), ".codeium", "windsurf")], ["windsurf"]);
  },

  async install(ctx: InstallContext) {
    editJsonFile(hooksPath(ctx.home), (cfg) => {
      const hooks = ensureObj(cfg, "hooks");
      const cmd = `${ctx.command} gate --agent windsurf`;
      for (const ev of EVENTS) {
        hooks[ev] = upsertMarked(asArray(hooks[ev]), { command: cmd, powershell: cmd });
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
      pruneEmpty(c, "hooks");
    });
  },

  async isInstalled(ctx: InstallContext) {
    const cfg = readJsonSafe(hooksPath(ctx.home));
    return isObj(cfg.hooks) && hasMarked(asArray(cfg.hooks.pre_run_command));
  },

  parseStdin(json: unknown) {
    if (!isObj(json)) return {};
    const action = str(json.agent_action_name) ?? str(json.hook_name);
    const info = json.tool_info;
    let summary: string | undefined;
    if (isObj(info)) {
      summary =
        str(info.command_line) ??
        str(info.tool_name) ??
        str(info.file_path) ??
        str(info.explanation) ??
        summarizeInput(info);
    }
    return {
      tool: action ? oneLine(action, 120) : undefined,
      summary: summary ? oneLine(summary) : undefined,
      sessionId: str(json.conversation_id) ?? str(json.trajectory_id) ?? str(json.session_id),
    };
  },

  respond(outcome) {
    return outcome === "pass" ? { stdout: "", exitCode: 0 } : { stdout: "", exitCode: 2 };
  },
};
