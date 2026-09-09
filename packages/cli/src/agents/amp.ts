/**
 * Amp — legacy `delegate` permission helper in ~/.config/amp/settings.json.
 * Exit 1 = "ask the operator" (our passthrough). Exit 2 = reject.
 */
import type { AgentAdapter, InstallContext } from "./types.js";
import { asArray, detectByDirOrBin, editJsonFile, hasMarked, homePath, parseClaudeShaped, pruneEmpty, readJsonSafe, removeMarked, upsertMarked } from "./util.js";
import { userHome } from "../paths.js";

const KEY = "amp.permissions";

function settingsPath(home: string): string {
  return homePath(home, ".config", "amp", "settings.json");
}

export const ampAdapter: AgentAdapter = {
  id: "amp",
  displayName: "Amp",
  tier: 2,
  supportsMcp: false,
  notes: "Uses Amp's `delegate` permission action; exit 1 hands the decision back to you.",

  async detect() {
    return detectByDirOrBin([homePath(userHome(), ".config", "amp")], ["amp"]);
  },

  async install(ctx: InstallContext) {
    editJsonFile(settingsPath(ctx.home), (cfg) => {
      cfg[KEY] = upsertMarked(asArray(cfg[KEY]), {
        tool: "*",
        action: "delegate",
        to: `${ctx.command} gate --agent amp`,
      });
    });
  },

  async uninstall(ctx: InstallContext) {
    const cfg = readJsonSafe(settingsPath(ctx.home));
    if (!Array.isArray(cfg[KEY])) return;
    editJsonFile(settingsPath(ctx.home), (c) => {
      c[KEY] = removeMarked(asArray(c[KEY]));
      pruneEmpty(c, KEY);
    });
  },

  async isInstalled(ctx: InstallContext) {
    return hasMarked(asArray(readJsonSafe(settingsPath(ctx.home))[KEY]));
  },

  parseStdin(json: unknown) {
    return parseClaudeShaped(json);
  },

  respond(outcome) {
    return outcome === "pass" ? { stdout: "", exitCode: 1 } : { stdout: "", exitCode: 2 };
  },
};
