/**
 * `fitgate init` — detect agents, write hooks, register MCP, start the daemon.
 * Idempotent: re-running updates our entries in place and never touches others.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { AgentId } from "@fitgate/shared";
import { adapters } from "./agents/registry.js";
import type { AgentAdapter, InstallContext } from "./agents/types.js";
import { MCP_AGENTS, registerMcp, unregisterMcp } from "./agents/mcp-registration.js";
import { loadConfig, updateConfig } from "./config.js";
import { daemonUrl, ensureDaemon, isDaemonUp } from "./client.js";
import { ensureHome, userHome } from "./paths.js";
import { fileExists, onPath } from "./fsutil.js";
import { cliEntryPath } from "./client.js";
import { isSea } from "node:sea";

export interface InitOptions {
  agents?: string[];
  uninstall?: boolean;
  daemon?: boolean;
  yes?: boolean;
  agentsMd?: boolean;
  command?: string;
}

export const AGENTS_MD_SNIPPET = `
## FitGate

Before asking the user to approve any action (running commands, editing files, spending money), call the \`fitgate_gate\` tool and wait for it to return \`cleared\`.
`;

function out(msg = ""): void {
  process.stdout.write(msg + "\n");
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} [Y/n] `, resolve));
  rl.close();
  return !/^n/i.test(answer.trim());
}

/**
 * The launcher hooks will invoke. `fitgate` when it is on PATH (global npm
 * install, npm link, or a standalone SEA binary named `fitgate` on PATH);
 * a standalone SEA binary not on PATH re-invokes itself by absolute path
 * (it has no dist/index.js to hand to `node`); otherwise `node
 * "…/dist/index.js"` so hooks keep working even when the npm bin directory
 * is not on the agent's PATH.
 */
export function resolveLauncher(): string {
  if (onPath("fitgate")) return "fitgate";
  if (isSea()) return `"${process.execPath}"`;
  // `node` (bare) works as the first token in PowerShell, cmd and bash alike; a
  // quoted absolute exe path would not (PowerShell parses it as a string).
  return `node "${cliEntryPath()}"`;
}

export function buildContext(command = resolveLauncher()): InstallContext {
  const config = loadConfig();
  return {
    home: userHome(),
    command,
    hookTimeoutSeconds: config.rules.waitTimeoutSeconds + 60,
    log: (m) => out("  " + m),
  };
}

function parseAgentList(list: string[] | undefined): AgentAdapter[] | null {
  if (!list || list.length === 0) return null;
  const ids = list.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  const chosen: AgentAdapter[] = [];
  for (const id of ids) {
    const a = adapters.find((x) => x.id === id);
    if (!a) throw new Error(`unknown agent "${id}". Known: ${adapters.map((x) => x.id).join(", ")}`);
    chosen.push(a);
  }
  return chosen;
}

export async function runInit(opts: InitOptions): Promise<void> {
  ensureHome();
  const command = opts.command ?? resolveLauncher();
  const ctx = buildContext(command);
  if (command !== "fitgate") out(`\`fitgate\` is not on PATH — hooks will use: ${command}`);
  const restricted = parseAgentList(opts.agents);

  if (opts.uninstall) return uninstall(ctx, restricted);

  out("FitGate — detecting coding agents…");
  const detected: AgentAdapter[] = [];
  for (const a of restricted ?? adapters) {
    const ok = restricted ? true : await a.detect();
    if (ok) detected.push(a);
    out(`  ${ok ? "✓" : "·"} ${a.displayName.padEnd(28)} ${ok ? "(tier " + a.tier + ")" : "not found"}`);
  }
  if (detected.length === 0) {
    out("\nNo supported agents found. Use --agents <id,...> to force, e.g. --agents claude-code,cursor.");
    out(`Known agents: ${adapters.map((a) => a.id).join(", ")}`);
  } else {
    out("\nWill install hooks for: " + detected.map((a) => a.displayName).join(", "));
    const mcpTargets = detected.map((a) => a.id).filter((id) => MCP_AGENTS.includes(id));
    if (mcpTargets.length) out("Will register the `fitgate mcp` server for: " + mcpTargets.join(", "));
    if (!opts.yes && !(await confirm("Proceed?"))) {
      out("Aborted.");
      return;
    }
    const installed: AgentId[] = [];
    for (const a of detected) {
      try {
        await a.install(ctx);
        installed.push(a.id);
        out(`  ✓ ${a.displayName}${a.notes ? " — " + a.notes : ""}`);
      } catch (err) {
        out(`  ✗ ${a.displayName}: ${(err as Error).message}`);
      }
    }
    registerMcp(ctx.home, mcpTargets, command, ctx.log);
    const prev = loadConfig().installedAgents;
    updateConfig({ installedAgents: Array.from(new Set([...prev, ...installed])) });
  }

  if (opts.agentsMd) {
    const file = path.join(process.cwd(), "AGENTS.md");
    const existing = fileExists(file) ? fs.readFileSync(file, "utf8") : "";
    if (existing.includes("fitgate_gate")) out(`AGENTS.md already mentions fitgate_gate — left unchanged.`);
    else {
      fs.writeFileSync(file, (existing ? existing.replace(/\s*$/, "\n") : "# Agent instructions\n") + AGENTS_MD_SNIPPET);
      out(`Wrote FitGate snippet to ${file}`);
    }
  }

  const url = daemonUrl();
  if (opts.daemon !== false) {
    const up = await ensureDaemon();
    out(up ? `\nDaemon running at ${url}` : `\nCould not start the daemon; run \`fitgate daemon\` in a terminal to see why.`);
  } else {
    out(`\nDaemon not started (--no-daemon). Start it with \`fitgate daemon --ensure\`.`);
  }

  out(`
Next steps:
  • Restart your agents so they pick up the new hooks.
  • Keep ${url} open in a tab — that's where the gate appears.
  • \`fitgate status\` shows today's stats; \`fitgate pause 30m\` if you're in a meeting.
  • \`fitgate login <server-url>\` to sync a clinician-reviewed plan (optional).`);
}

async function uninstall(ctx: InstallContext, restricted: AgentAdapter[] | null): Promise<void> {
  out("FitGate — removing hooks…");
  const targets = restricted ?? adapters;
  const removed: AgentId[] = [];
  for (const a of targets) {
    try {
      if (await a.isInstalled(ctx)) {
        await a.uninstall(ctx);
        removed.push(a.id);
        out(`  ✓ ${a.displayName}`);
      } else {
        out(`  · ${a.displayName} (not installed)`);
      }
    } catch (err) {
      out(`  ✗ ${a.displayName}: ${(err as Error).message}`);
    }
  }
  unregisterMcp(ctx.home, targets.map((a) => a.id).filter((id) => MCP_AGENTS.includes(id)), ctx.log);
  const prev = loadConfig().installedAgents;
  updateConfig({ installedAgents: prev.filter((id) => !targets.some((a) => a.id === id)) });
  if (await isDaemonUp()) out("\nThe daemon is still running; stop it with `fitgate daemon --stop`.");
  out("Done. Your ~/.fitgate data was left in place.");
}
