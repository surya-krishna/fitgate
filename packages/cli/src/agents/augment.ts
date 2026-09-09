/**
 * Augment (Auggie) — `PreToolUse` hook in ~/.augment/settings.json.
 * Passthrough: exit 0, no stdout. Deny: hookSpecificOutput with permissionDecision "deny".
 */
import type { AgentAdapter, InstallContext } from "./types.js";
import { DENY_MESSAGE } from "./types.js";
import { detectByDirOrBin, homePath, parseClaudeShaped } from "./util.js";
import { gateCommand, installClaudeStyle, isInstalledClaudeStyle, uninstallClaudeStyle } from "./claude-style.js";
import { userHome } from "../paths.js";

function settingsPath(home: string): string {
  return homePath(home, ".augment", "settings.json");
}

export const augmentAdapter: AgentAdapter = {
  id: "augment",
  displayName: "Augment (Auggie)",
  tier: 2,
  supportsMcp: true,

  async detect() {
    return detectByDirOrBin([homePath(userHome(), ".augment")], ["auggie"]);
  },

  async install(ctx: InstallContext) {
    installClaudeStyle(settingsPath(ctx.home), [
      {
        event: "PreToolUse",
        matcher: "",
        hook: { type: "command", command: gateCommand(ctx, "augment"), timeout: ctx.hookTimeoutSeconds },
      },
    ]);
  },

  async uninstall(ctx: InstallContext) {
    uninstallClaudeStyle(settingsPath(ctx.home), ["PreToolUse"]);
  },

  async isInstalled(ctx: InstallContext) {
    return isInstalledClaudeStyle(settingsPath(ctx.home), "PreToolUse");
  },

  parseStdin(json: unknown) {
    return parseClaudeShaped(json);
  },

  respond(outcome, message = DENY_MESSAGE) {
    if (outcome === "pass") return { stdout: "", exitCode: 0 };
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: message },
      }),
      exitCode: 0,
    };
  },
};
