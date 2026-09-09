/**
 * Shared install logic for agents whose hook config mirrors Claude Code's
 * `{ hooks: { <Event>: [ { matcher, hooks: [ { type: "command", command, timeout } ] } ] } }`
 * shape (Claude Code, Codex, Augment, Gemini).
 */
import type { InstallContext } from "./types.js";
import { asArray, editJsonFile, ensureObj, hasMarked, isObj, pruneEmpty, readJsonSafe, removeMarked, upsertMarked, type JsonObject } from "./util.js";

export interface HookSpec {
  event: string;
  matcher: string;
  /** The inner hook object; `_fitgate` is added to the outer matcher entry. */
  hook: JsonObject;
}

export function installClaudeStyle(file: string, specs: HookSpec[]): void {
  editJsonFile(file, (cfg) => {
    const hooks = ensureObj(cfg, "hooks");
    for (const s of specs) {
      hooks[s.event] = upsertMarked(asArray(hooks[s.event]), { matcher: s.matcher, hooks: [s.hook] });
    }
  });
}

export function uninstallClaudeStyle(file: string, events: string[]): void {
  const cfg = readJsonSafe(file);
  if (!isObj(cfg.hooks)) return;
  editJsonFile(file, (c) => {
    const hooks = ensureObj(c, "hooks");
    for (const ev of events) {
      if (!Array.isArray(hooks[ev])) continue;
      hooks[ev] = removeMarked(asArray(hooks[ev]));
      pruneEmpty(hooks, ev);
    }
    pruneEmpty(c, "hooks");
  });
}

export function isInstalledClaudeStyle(file: string, event: string): boolean {
  const cfg = readJsonSafe(file);
  return isObj(cfg.hooks) && hasMarked(asArray(cfg.hooks[event]));
}

export function gateCommand(ctx: InstallContext, agent: string): string {
  return `${ctx.command} gate --agent ${agent}`;
}
