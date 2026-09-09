/**
 * Claude Code — `PermissionRequest` hook in ~/.claude/settings.json.
 * Docs: https://code.claude.com/docs/en/hooks
 * Passthrough: exit 0, no stdout. Deny: hookSpecificOutput JSON.
 */
import type { AgentAdapter, InstallContext } from "./types.js";
import { DENY_MESSAGE } from "./types.js";
import { detectByDirOrBin, homePath, parseClaudeShaped } from "./util.js";
import { gateCommand, installClaudeStyle, isInstalledClaudeStyle, uninstallClaudeStyle } from "./claude-style.js";
import { userHome } from "../paths.js";

function settingsPath(home: string): string {
  return homePath(home, ".claude", "settings.json");
}

export const claudeCodeAdapter: AgentAdapter = {
  id: "claude-code",
  displayName: "Claude Code",
  tier: 1,
  supportsMcp: true,
  notes: "PermissionRequest hook — fires exactly when Claude would ask you. Not in `claude -p` or with --dangerously-skip-permissions.",

  async detect() {
    return detectByDirOrBin([homePath(userHome(), ".claude")], ["claude"]);
  },

  async install(ctx: InstallContext) {
    installClaudeStyle(settingsPath(ctx.home), [
      {
        event: "PermissionRequest",
        matcher: "",
        hook: { type: "command", command: gateCommand(ctx, "claude-code"), timeout: ctx.hookTimeoutSeconds },
      },
      {
        event: "SessionStart",
        matcher: "",
        hook: { type: "command", command: `${ctx.command} daemon --ensure`, timeout: 10 },
      },
    ]);
  },

  async uninstall(ctx: InstallContext) {
    uninstallClaudeStyle(settingsPath(ctx.home), ["PermissionRequest", "SessionStart"]);
  },

  async isInstalled(ctx: InstallContext) {
    return isInstalledClaudeStyle(settingsPath(ctx.home), "PermissionRequest");
  },

  parseStdin(json: unknown) {
    return parseClaudeShaped(json);
  },

  respond(outcome, message = DENY_MESSAGE) {
    if (outcome === "pass") return { stdout: "", exitCode: 0 };
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: "PermissionRequest", decision: "deny", decisionReason: message },
      }),
      exitCode: 0,
    };
  },
};
