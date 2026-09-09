/**
 * Registers the `fitgate mcp` stdio server with agents that support MCP.
 * JSON files are merged (the `fitgate` server key is the idempotency marker);
 * Codex's config.toml gets a minimal appended table (no TOML parser).
 */
import fs from "node:fs";
import path from "node:path";
import type { AgentId } from "@fitgate/shared";
import { editJsonFile, ensureObj, homePath, isObj, pruneEmpty, readJsonSafe } from "./util.js";
import { writeFileAtomic } from "../fsutil.js";

export const MCP_SERVER_NAME = "fitgate";

interface JsonTarget {
  agent: AgentId;
  file: (home: string) => string;
  /** Extra fields some clients want on the entry. */
  extra?: Record<string, unknown>;
}

const JSON_TARGETS: JsonTarget[] = [
  { agent: "claude-code", file: (h) => homePath(h, ".claude.json"), extra: { type: "stdio" } },
  { agent: "cursor", file: (h) => homePath(h, ".cursor", "mcp.json") },
  { agent: "gemini", file: (h) => homePath(h, ".gemini", "settings.json") },
  { agent: "windsurf", file: (h) => homePath(h, ".codeium", "windsurf", "mcp_config.json") },
];

const CODEX_TOML = (h: string) => homePath(h, ".codex", "config.toml");
const TOML_BEGIN = "# >>> fitgate (managed by `fitgate init`)";
const TOML_END = "# <<< fitgate";

export const MCP_AGENTS: AgentId[] = [...JSON_TARGETS.map((t) => t.agent), "codex"];

/** Split a launcher like `fitgate` or `"C:\\...\\node.exe" "C:\\...\\index.js"` into command + leading args. */
export function splitLauncher(launcher: string): { command: string; args: string[] } {
  const parts = launcher.match(/"[^"]*"|\S+/g) ?? ["fitgate"];
  const [command = "fitgate", ...args] = parts.map((x) => x.replace(/^"|"$/g, ""));
  return { command, args };
}

export function mcpEntry(launcher: string, extra?: Record<string, unknown>): Record<string, unknown> {
  const { command, args } = splitLauncher(launcher);
  return { ...(extra ?? {}), command, args: [...args, "mcp"] };
}

export function registerMcp(home: string, agents: AgentId[], command = "fitgate", log: (m: string) => void = () => {}): void {
  for (const t of JSON_TARGETS) {
    if (!agents.includes(t.agent)) continue;
    const file = t.file(home);
    try {
      editJsonFile(file, (cfg) => {
        const servers = ensureObj(cfg, "mcpServers");
        servers[MCP_SERVER_NAME] = mcpEntry(command, t.extra);
      });
      log(`registered MCP server in ${file}`);
    } catch (err) {
      log(`skipped MCP registration for ${t.agent}: ${(err as Error).message}`);
    }
  }
  if (agents.includes("codex")) {
    const file = CODEX_TOML(home);
    try {
      let raw = "";
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        /* new file */
      }
      if (!/^\s*\[mcp_servers\.fitgate\]/m.test(raw)) {
        const l = splitLauncher(command);
        const block = `${TOML_BEGIN}\n[mcp_servers.${MCP_SERVER_NAME}]\ncommand = ${JSON.stringify(l.command)}\nargs = ${JSON.stringify([...l.args, "mcp"])}\n${TOML_END}\n`;
        const next = raw.length === 0 || raw.endsWith("\n") ? raw + (raw.length ? "\n" : "") + block : raw + "\n\n" + block;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeFileAtomic(file, next);
        log(`registered MCP server in ${file}`);
      }
    } catch (err) {
      log(`skipped MCP registration for codex: ${(err as Error).message}`);
    }
  }
}

export function unregisterMcp(home: string, agents: AgentId[], log: (m: string) => void = () => {}): void {
  for (const t of JSON_TARGETS) {
    if (!agents.includes(t.agent)) continue;
    const file = t.file(home);
    const cfg = readJsonSafe(file);
    if (!isObj(cfg.mcpServers) || !(MCP_SERVER_NAME in cfg.mcpServers)) continue;
    try {
      editJsonFile(file, (c) => {
        const servers = ensureObj(c, "mcpServers");
        delete servers[MCP_SERVER_NAME];
        pruneEmpty(c, "mcpServers");
      });
      log(`removed MCP server from ${file}`);
    } catch (err) {
      log(`could not edit ${file}: ${(err as Error).message}`);
    }
  }
  if (agents.includes("codex")) {
    const file = CODEX_TOML(home);
    try {
      const raw = fs.readFileSync(file, "utf8");
      const re = new RegExp(`\\n?${escapeRe(TOML_BEGIN)}[\\s\\S]*?${escapeRe(TOML_END)}\\n?`, "g");
      const next = raw.replace(re, "\n");
      if (next !== raw) {
        writeFileAtomic(file, next.replace(/\n{3,}/g, "\n\n"));
        log(`removed MCP server from ${file}`);
      }
    } catch {
      /* no file */
    }
  }
}

export function isMcpRegistered(home: string, agent: AgentId): boolean {
  if (agent === "codex") {
    try {
      return /^\s*\[mcp_servers\.fitgate\]/m.test(fs.readFileSync(CODEX_TOML(home), "utf8"));
    } catch {
      return false;
    }
  }
  const t = JSON_TARGETS.find((x) => x.agent === agent);
  if (!t) return false;
  const cfg = readJsonSafe(t.file(home));
  return isObj(cfg.mcpServers) && MCP_SERVER_NAME in cfg.mcpServers;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
