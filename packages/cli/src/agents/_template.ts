/**
 * Template for a new agent adapter. Copy this file to `<agent>.ts`, fill in
 * the five methods, register it in `registry.ts`, add a fixture under
 * `test/fixtures/<agent>.json`, and add a row to docs/AGENT-INTEGRATIONS.md.
 */
import type { AgentAdapter, InstallContext } from "./types.js";
import { DENY_MESSAGE } from "./types.js";
import { detectByDirOrBin, editJsonFile, ensureObj, hasMarked, asArray, upsertMarked, removeMarked, pruneEmpty, homePath, parseClaudeShaped, readJsonSafe } from "./util.js";

// Change these three lines for your agent.
const CONFIG_DIR = ".my-agent";
const CONFIG_FILE = "hooks.json";
const HOOK_EVENT = "PreToolUse";

function configPath(home: string): string {
  return homePath(home, CONFIG_DIR, CONFIG_FILE);
}

export const templateAdapter: AgentAdapter = {
  // Use a real AgentId from @fitgate/shared here (extend the enum in packages/shared first).
  id: "unknown",
  displayName: "My Agent",
  tier: 2,

  async detect() {
    return detectByDirOrBin([homePath(process.env.HOME ?? "", CONFIG_DIR)], ["my-agent"]);
  },

  async install(ctx: InstallContext) {
    editJsonFile(configPath(ctx.home), (cfg) => {
      const hooks = ensureObj(cfg, "hooks");
      hooks[HOOK_EVENT] = upsertMarked(asArray(hooks[HOOK_EVENT]), {
        matcher: "",
        hooks: [{ type: "command", command: `${ctx.command} gate --agent my-agent`, timeout: ctx.hookTimeoutSeconds }],
      });
    });
  },

  async uninstall(ctx: InstallContext) {
    editJsonFile(configPath(ctx.home), (cfg) => {
      const hooks = ensureObj(cfg, "hooks");
      hooks[HOOK_EVENT] = removeMarked(asArray(hooks[HOOK_EVENT]));
      pruneEmpty(hooks, HOOK_EVENT);
      pruneEmpty(cfg, "hooks");
    });
  },

  async isInstalled(ctx: InstallContext) {
    const cfg = readJsonSafe(configPath(ctx.home));
    const hooks = cfg.hooks;
    return Boolean(hooks && typeof hooks === "object" && hasMarked(asArray((hooks as Record<string, unknown>)[HOOK_EVENT])));
  },

  parseStdin(json: unknown) {
    // Most agents send { tool_name, tool_input, session_id }.
    return parseClaudeShaped(json);
  },

  respond(outcome, message = DENY_MESSAGE) {
    // Passthrough must let the agent's own approval prompt show.
    if (outcome === "pass") return { stdout: "", exitCode: 0 };
    return { stdout: JSON.stringify({ decision: "deny", reason: message }), exitCode: 0 };
  },
};
