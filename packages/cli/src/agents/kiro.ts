/**
 * Kiro — `preToolUse` hook, written as ~/.kiro/hooks/fitgate.kiro.hook.
 * Passthrough: exit 0. Deny: exit 1 + reason on stderr.
 * Best effort: Kiro's hook file format is evolving; the file we write is entirely ours.
 */
import fs from "node:fs";
import type { AgentAdapter, InstallContext } from "./types.js";
import { DENY_MESSAGE } from "./types.js";
import { detectByDirOrBin, homePath, parseClaudeShaped } from "./util.js";
import { fileExists, writeJsonAtomic } from "../fsutil.js";
import { userHome } from "../paths.js";

function hookFile(home: string): string {
  return homePath(home, ".kiro", "hooks", "fitgate.kiro.hook");
}

export const kiroAdapter: AgentAdapter = {
  id: "kiro",
  displayName: "Kiro",
  tier: 2,
  supportsMcp: false,
  notes: "Kiro hook format is best-effort; verify in Kiro's hooks panel after install.",

  async detect() {
    return detectByDirOrBin([homePath(userHome(), ".kiro")], ["kiro", "kiro-cli"]);
  },

  async install(ctx: InstallContext) {
    writeJsonAtomic(hookFile(ctx.home), {
      name: "FitGate",
      description: "Micro-workout gate before tool approvals",
      version: "1",
      enabled: true,
      when: { type: "preToolUse" },
      then: { type: "runCommand", command: `${ctx.command} gate --agent kiro`, timeoutSec: ctx.hookTimeoutSeconds },
      _fitgate: true,
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
    return parseClaudeShaped(json);
  },

  respond(outcome, message = DENY_MESSAGE) {
    if (outcome === "pass") return { stdout: "", exitCode: 0 };
    return { stdout: "", exitCode: 1, stderr: message };
  },
};
