/**
 * Gemini CLI — `BeforeTool` hook in ~/.gemini/settings.json. Timeout is in
 * MILLISECONDS. There is no "ask" decision: passthrough is `{}`.
 * Docs: https://geminicli.com/docs/hooks/reference/
 */
import type { AgentAdapter, InstallContext } from "./types.js";
import { DENY_MESSAGE } from "./types.js";
import { detectByDirOrBin, homePath, parseClaudeShaped } from "./util.js";
import { gateCommand, installClaudeStyle, isInstalledClaudeStyle, uninstallClaudeStyle } from "./claude-style.js";
import { userHome } from "../paths.js";

const MATCHER = "run_shell_command|write_file|replace";

function settingsPath(home: string): string {
  return homePath(home, ".gemini", "settings.json");
}

export const geminiAdapter: AgentAdapter = {
  id: "gemini",
  displayName: "Gemini CLI",
  tier: 2,
  supportsMcp: true,
  notes: "BeforeTool fires on every matching call; the daemon's cooldown does the rate limiting.",

  async detect() {
    return detectByDirOrBin([homePath(userHome(), ".gemini")], ["gemini"]);
  },

  async install(ctx: InstallContext) {
    installClaudeStyle(settingsPath(ctx.home), [
      {
        event: "BeforeTool",
        matcher: MATCHER,
        hook: {
          name: "fitgate",
          type: "command",
          command: gateCommand(ctx, "gemini"),
          timeout: ctx.hookTimeoutSeconds * 1000,
        },
      },
    ]);
  },

  async uninstall(ctx: InstallContext) {
    uninstallClaudeStyle(settingsPath(ctx.home), ["BeforeTool"]);
  },

  async isInstalled(ctx: InstallContext) {
    return isInstalledClaudeStyle(settingsPath(ctx.home), "BeforeTool");
  },

  parseStdin(json: unknown) {
    return parseClaudeShaped(json);
  },

  respond(outcome, message = DENY_MESSAGE) {
    if (outcome === "pass") return { stdout: "{}", exitCode: 0 };
    return { stdout: JSON.stringify({ decision: "deny", reason: message }), exitCode: 0 };
  },
};
