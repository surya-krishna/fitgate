#!/usr/bin/env node
/**
 * fitgate — gate your coding agent's approval prompts behind micro-workouts.
 */
import fs from "node:fs";
import os from "node:os";
import readline from "node:readline";
import { Command } from "commander";
import { DevicePairResponse } from "@fitgate/shared";
import { cliVersion } from "./version.js";
import { runGate } from "./gate.js";
import { runInit } from "./init.js";
import { runWrap } from "./wrap.js";
import {
  daemonFetch,
  daemonPort,
  daemonUrl,
  ensureDaemon,
  getStatus,
  isDaemonUp,
  pauseDaemon,
  resolveGate,
  resumeDaemon,
  spawnDaemonDetached,
} from "./client.js";
import { ensureHome, files, fitgateHome, userHome } from "./paths.js";
import { loadConfig, updateConfig, isPaired } from "./config.js";
import { readJsonFile, removeIfExists } from "./fsutil.js";

const program = new Command();

function out(msg = ""): void {
  process.stdout.write(msg + "\n");
}

function fail(msg: string, code = 1): never {
  process.stderr.write(`fitgate: ${msg}\n`);
  process.exit(code);
}

/** "30m", "2h", "90" (minutes), "1h30m" → minutes. */
export function parseDuration(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const str = s.trim().toLowerCase();
  if (/^\d+$/.test(str)) return Number(str);
  let total = 0;
  let matched = false;
  for (const m of str.matchAll(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|d|day|days)/g)) {
    matched = true;
    const n = Number(m[1]);
    const unit = m[2]!;
    if (unit.startsWith("h")) total += n * 60;
    else if (unit.startsWith("d")) total += n * 24 * 60;
    else total += n;
  }
  if (!matched) throw new Error(`cannot parse duration "${s}" (try 30m, 2h, 90)`);
  return Math.round(total);
}

program
  .name("fitgate")
  .description("Gate your coding agent's approval prompts behind micro-workouts.")
  .version(cliVersion())
  .enablePositionalOptions();

program
  .command("init")
  .description("Detect installed agents, install hooks + MCP registration, start the daemon (idempotent)")
  .option("--agents <ids>", "comma-separated agent ids to restrict to (e.g. claude-code,cursor)", (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option("--uninstall", "remove FitGate hooks and MCP registrations")
  .option("--no-daemon", "do not start the daemon")
  .option("-y, --yes", "skip confirmation")
  .option("--agents-md", "append the fitgate_gate instruction snippet to ./AGENTS.md")
  .option("--command <cmd>", "command to write into hooks (default: fitgate)")
  .action(async (opts: { agents: string[]; uninstall?: boolean; daemon: boolean; yes?: boolean; agentsMd?: boolean; command?: string }) => {
    try {
      await runInit({ agents: opts.agents, uninstall: opts.uninstall, daemon: opts.daemon, yes: opts.yes, agentsMd: opts.agentsMd, command: opts.command });
    } catch (err) {
      fail((err as Error).message);
    }
  });

program
  .command("gate")
  .description("Hook entry point: read agent JSON on stdin, block on a micro-workout, print the agent's response")
  .requiredOption("--agent <id>", "agent id (claude-code, cursor, copilot, codex, gemini, windsurf, augment, kiro, amp, cline)")
  .action(async (opts: { agent: string }) => {
    await runGate(opts.agent);
  });

program
  .command("daemon")
  .description("Run the local daemon in the foreground")
  .option("--ensure", "start a detached daemon if none is running, then exit")
  .option("--stop", "stop a running daemon")
  .option("--port <n>", "listen port (default: config.port / 4820)")
  .action(async (opts: { ensure?: boolean; stop?: boolean; port?: string }) => {
    const port = opts.port ? Number(opts.port) : daemonPort();
    if (opts.stop) {
      const pid = readPid();
      if (!pid) {
        out("no daemon.pid found");
        return;
      }
      try {
        process.kill(pid, "SIGTERM");
        out(`sent SIGTERM to daemon (pid ${pid})`);
      } catch (err) {
        removeIfExists(files.daemonPid());
        out(`daemon (pid ${pid}) not running: ${(err as Error).message}`);
      }
      return;
    }
    if (opts.ensure) {
      if (await isDaemonUp(port)) return;
      spawnDaemonDetached();
      // Give it a moment so the caller's next hook finds it, but never block long.
      const ok = await ensureDaemon(port, 2500);
      if (!ok) process.stderr.write("fitgate: daemon did not come up within 2.5s (check ~/.fitgate/daemon.log)\n");
      return;
    }
    if (await isDaemonUp(port)) {
      out(`A daemon is already running at ${daemonUrl(port)}.`);
      return;
    }
    const { startDaemon } = await import("./daemon/server.js");
    const foreground = !process.env.FITGATE_DAEMON_CHILD && Boolean(process.stderr.isTTY);
    const log = (line: string) => {
      const l = `${new Date().toISOString()} ${line}`;
      try {
        fs.appendFileSync(files.daemonLog(), l + "\n");
      } catch {
        /* ignore */
      }
      if (foreground) process.stderr.write(l + "\n");
    };
    let running: Awaited<ReturnType<typeof startDaemon>>;
    try {
      running = await startDaemon({ port, log });
    } catch (err) {
      fail(`could not start daemon on port ${port}: ${(err as Error).message}`);
    }
    if (foreground) out(`FitGate daemon listening on ${running.url} — open it in a browser. Ctrl-C to stop.`);
    const shutdown = (sig: string) => {
      log(`received ${sig}, shutting down`);
      running.close().finally(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGHUP", () => shutdown("SIGHUP"));
    process.on("uncaughtException", (err) => log(`uncaught: ${err.stack ?? err.message}`));
    process.on("unhandledRejection", (err) => log(`unhandled rejection: ${String(err)}`));
  });

program
  .command("mcp")
  .description("Run the stdio MCP server (tools: fitgate_gate, fitgate_status, fitgate_done)")
  .action(async () => {
    const { runMcpServer } = await import("./mcp.js");
    await runMcpServer();
  });

program
  .command("status")
  .description("Today's stats, streak, open gate, plan version")
  .option("--json", "machine-readable output")
  .action(async (opts: { json?: boolean }) => {
    if (!(await isDaemonUp())) {
      if (opts.json) out(JSON.stringify({ daemon: false }));
      else out(`Daemon not running (${daemonUrl()}). Start it with: fitgate daemon --ensure`);
      process.exitCode = 1;
      return;
    }
    const st = await getStatus();
    if (opts.json) return out(JSON.stringify(st, null, 2));
    const cfg = loadConfig();
    out(`FitGate v${st.version} — ${daemonUrl()}`);
    out(`  today:   ${st.today.completed} done · ${st.today.skipped} skipped · ${st.today.gatesServed} gates served`);
    out(`  streak:  ${st.today.streakDays} day${st.today.streakDays === 1 ? "" : "s"}`);
    out(`  plan:    ${st.plan ? `${st.plan.title} (v${st.plan.version}, ${st.plan.status})` : "default pool (no synced plan)"}`);
    out(`  paused:  ${st.paused ? `yes${st.pausedUntil ? " until " + new Date(st.pausedUntil).toLocaleTimeString() : ""}` : "no"}`);
    out(`  server:  ${isPaired(cfg) ? `${cfg.serverUrl} (${st.serverConnected ? "connected" : "not reachable"})` : "not paired (offline mode)"}`);
    out(`  last:    ${st.lastGateAt ? new Date(st.lastGateAt).toLocaleString() : "never"}`);
    out(`  open:    ${st.openGate ? `${st.openGate.task.label} for ${st.openGate.agent} — \`fitgate done\` when finished` : "none"}`);
  });

async function resolveOpen(outcome: "completed" | "skipped"): Promise<void> {
  if (!(await isDaemonUp())) fail("daemon not running");
  const st = await getStatus();
  if (!st.openGate) {
    out("No open gate.");
    return;
  }
  const g = await resolveGate(st.openGate.id, { outcome });
  out(outcome === "completed" ? `Done: ${g.task.label} ✓` : `Skipped: ${g.task.label}`);
}

program.command("done").description("Mark the open gate as completed").action(() => resolveOpen("completed"));
program.command("skip").description("Skip the open gate").action(() => resolveOpen("skipped"));

program
  .command("pause")
  .description("Pass all gates for a while (e.g. `fitgate pause 30m`, `2h`; no duration = until resume)")
  .argument("[duration]", "30m, 2h, 90 (minutes)")
  .action(async (duration?: string) => {
    let minutes: number | undefined;
    try {
      minutes = parseDuration(duration);
    } catch (err) {
      fail((err as Error).message);
    }
    if (!(await ensureDaemon())) fail("daemon not running");
    const st = await pauseDaemon(minutes);
    out(`Paused${st.pausedUntil ? ` until ${new Date(st.pausedUntil).toLocaleTimeString()}` : " until \`fitgate resume\`"}.`);
  });

program
  .command("resume")
  .description("Resume gating")
  .action(async () => {
    if (!(await ensureDaemon())) fail("daemon not running");
    await resumeDaemon();
    out("Resumed.");
  });

program
  .command("login")
  .description("Pair this device with a FitGate server using the 8-character code from the dashboard")
  .argument("<serverUrl>", "e.g. https://app.fitgate.dev or http://localhost:3000")
  .option("--code <code>", "pairing code (prompted if omitted)")
  .action(async (serverUrl: string, opts: { code?: string }) => {
    let base: string;
    try {
      base = new URL(serverUrl).toString().replace(/\/+$/, "");
    } catch {
      fail(`invalid URL: ${serverUrl}`);
    }
    let code = opts.code?.trim();
    if (!code) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      code = (await new Promise<string>((r) => rl.question("Pairing code (8 characters): ", r))).trim();
      rl.close();
    }
    if (!code || code.length !== 8) fail("the pairing code must be exactly 8 characters");
    let res: Response;
    try {
      res = await fetch(`${base}/api/v1/device/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairingCode: code, deviceName: os.hostname().slice(0, 80), platform: `${process.platform}-${process.arch}`.slice(0, 40) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      fail(`could not reach ${base}: ${(err as Error).message}`);
    }
    if (!res.ok) fail(`pairing failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const parsed = DevicePairResponse.safeParse(await res.json());
    if (!parsed.success) fail("pairing failed: malformed server response");
    updateConfig({ serverUrl: base, deviceId: parsed.data.deviceId, deviceToken: parsed.data.deviceToken });
    out(`Paired with ${base} as device ${parsed.data.deviceId}.`);
    if (await isDaemonUp()) {
      await daemonFetch("/v1/reload", { method: "POST", body: "{}" }).catch(() => undefined);
      const r = await daemonFetch<{ ok: boolean; error?: string; planVersion: number | null }>("/v1/sync", { method: "POST", body: "{}", timeoutMs: 30_000 }).catch(() => null);
      if (r?.ok) out(r.planVersion ? `Synced plan v${r.planVersion}.` : "Synced (no active plan yet).");
      else if (r) out(`Sync: ${r.error}`);
    } else {
      out("Run `fitgate sync` (or start the daemon) to pull your plan.");
    }
  });

program
  .command("sync")
  .description("Pull the active plan and push queued events now")
  .action(async () => {
    const cfg = loadConfig();
    if (!isPaired(cfg)) fail("not paired; run `fitgate login <server-url>` first");
    if (await isDaemonUp()) {
      const r = await daemonFetch<{ ok: boolean; error?: string; planVersion: number | null; eventsPushed: number }>("/v1/sync", { method: "POST", body: "{}", timeoutMs: 30_000 });
      if (!r.ok) fail(`sync failed: ${r.error}`);
      out(`Synced: plan ${r.planVersion ? "v" + r.planVersion : "none"}, pushed ${r.eventsPushed} event(s).`);
      return;
    }
    const { StateStore } = await import("./state.js");
    const { syncOnce } = await import("./sync.js");
    const r = await syncOnce(cfg, new StateStore());
    if (!r.ok) fail(`sync failed: ${r.error}`);
    out(`Synced: plan ${r.planVersion ? "v" + r.planVersion : "none"}, pushed ${r.eventsPushed} event(s).`);
  });

program
  .command("doctor")
  .description("Verify hooks are installed and the daemon answers")
  .action(async () => {
    const { adapters } = await import("./agents/registry.js");
    const { isMcpRegistered, MCP_AGENTS } = await import("./agents/mcp-registration.js");
    const { buildContext } = await import("./init.js");
    const cfg = loadConfig();
    const ctx = buildContext();
    let problems = 0;
    out(`FitGate v${cliVersion()} · home ${fitgateHome()} · user home ${userHome()}`);
    out(`node ${process.version} on ${process.platform}-${process.arch}`);
    const up = await isDaemonUp();
    out(`${up ? "✓" : "✗"} daemon at ${daemonUrl()} ${up ? "answers" : "not running (fitgate daemon --ensure)"}`);
    if (!up) problems++;
    const pid = readPid();
    if (pid) out(`  daemon.pid = ${pid}`);
    out(`${isPaired(cfg) ? "✓" : "·"} server: ${isPaired(cfg) ? cfg.serverUrl : "not paired (offline mode, default pool)"}`);
    const plan = readJsonFile(files.plan());
    out(`${plan ? "✓" : "·"} plan.json ${plan ? "present" : "absent → default pool " + (cfg.useDefaultPoolWhenNoPlan ? "enabled" : "DISABLED (gates will pass)")}`);
    out(`  rules: cooldown ${cfg.rules.cooldownMinutes}m · cap ${cfg.rules.maxGatesPerDay}/day · wait ${cfg.rules.waitTimeoutSeconds}s · onSkip ${cfg.rules.onSkip}`);
    out("\nAgents:");
    for (const a of adapters) {
      const detected = await a.detect();
      const installed = await a.isInstalled(ctx);
      const mcp = MCP_AGENTS.includes(a.id) ? isMcpRegistered(ctx.home, a.id) : null;
      const expected = cfg.installedAgents.includes(a.id);
      let mark = "·";
      if (installed) mark = "✓";
      else if (expected) {
        mark = "✗";
        problems++;
      }
      out(`  ${mark} ${a.displayName.padEnd(28)} ${detected ? "detected" : "not detected"} · hooks ${installed ? "installed" : "absent"}${mcp === null ? "" : ` · mcp ${mcp ? "registered" : "absent"}`}`);
    }
    out(problems ? `\n${problems} problem(s). Run \`fitgate init\` to fix hooks.` : "\nAll good.");
    if (problems) process.exitCode = 1;
  });

program
  .command("wrap")
  .description("EXPERIMENTAL: run a command and gate (y/n)-style prompts in its output")
  .argument("<cmd...>", "command to run (use `--` before it)")
  .allowUnknownOption()
  .passThroughOptions()
  .action(async (cmd: string[]) => {
    process.exit(await runWrap(cmd));
  });

function readPid(): number | null {
  try {
    const n = Number(fs.readFileSync(files.daemonPid(), "utf8").trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

ensureHome();
program.parseAsync(process.argv).catch((err: Error) => {
  fail(err.message);
});
