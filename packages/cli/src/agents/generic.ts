/**
 * Fallback adapter for `--agent unknown|mcp|wrap` (or any id without a hook
 * adapter): parses Claude-shaped stdin, exit 0 with no stdout on pass, exit 2 on deny.
 */
import type { AgentId } from "@fitgate/shared";
import type { AgentAdapter } from "./types.js";
import { parseClaudeShaped } from "./util.js";

export function genericAdapter(id: AgentId): AgentAdapter {
  return {
    id,
    displayName: id,
    tier: 3,
    async detect() {
      return false;
    },
    async install() {
      /* nothing to install */
    },
    async uninstall() {
      /* nothing */
    },
    async isInstalled() {
      return false;
    },
    parseStdin(json) {
      return parseClaudeShaped(json);
    },
    respond(outcome) {
      return outcome === "pass" ? { stdout: "", exitCode: 0 } : { stdout: "", exitCode: 2 };
    },
  };
}
