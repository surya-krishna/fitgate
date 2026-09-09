/**
 * OpenAI Codex CLI — `PermissionRequest` hook in ~/.codex/hooks.json.
 * Docs: https://developers.openai.com/codex/hooks
 * Passthrough: exit 0, no stdout. Deny: hookSpecificOutput with decision {behavior:"deny"}.
 */
import type { AgentAdapter, InstallContext } from "./types.js";
import { DENY_MESSAGE } from "./types.js";
import { detectByDirOrBin, homePath, parseClaudeShaped } from "./util.js";
import { gateCommand, installClaudeStyle, isInstalledClaudeStyle, uninstallClaudeStyle } from "./claude-style.js";
import { userHome } from "../paths.js";

function hooksPath(home: string): string {
  return homePath(home, ".codex", "hooks.json");
}

export const codexAdapter: AgentAdapter = {
  id: "codex",
  displayName: "OpenAI Codex CLI",
  tier: 1,
  supportsMcp: true,
  notes: "Hooks are on by default; `[features] hooks = false` in ~/.codex/config.toml disables them.",

  async detect() {
    return detectByDirOrBin([homePath(userHome(), ".codex")], ["codex"]);
  },

  async install(ctx: InstallContext) {
    const cmd = gateCommand(ctx, "codex");
    installClaudeStyle(hooksPath(ctx.home), [
      {
        event: "PermissionRequest",
        matcher: "",
        hook: {
          type: "command",
          command: cmd,
          commandWindows: cmd,
          timeout: ctx.hookTimeoutSeconds,
          statusMessage: "FitGate: micro-workout time",
        },
      },
    ]);
  },

  async uninstall(ctx: InstallContext) {
    uninstallClaudeStyle(hooksPath(ctx.home), ["PermissionRequest"]);
  },

  async isInstalled(ctx: InstallContext) {
    return isInstalledClaudeStyle(hooksPath(ctx.home), "PermissionRequest");
  },

  parseStdin(json: unknown) {
    return parseClaudeShaped(json);
  },

  respond(outcome, message = DENY_MESSAGE) {
    if (outcome === "pass") return { stdout: "", exitCode: 0 };
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message } },
      }),
      exitCode: 0,
    };
  },
};
