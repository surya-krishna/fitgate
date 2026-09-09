/**
 * Minimal HTTP client for the local daemon + `ensureDaemon()`, which spawns a
 * detached daemon process if none answers on the configured port.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import {
  DaemonStatus,
  Gate,
  GateOpenResponse,
  GateRules,
  type GateOpenRequest,
  type GateResolveRequest,
} from "@fitgate/shared";
import { loadConfig } from "./config.js";

export function daemonPort(): number {
  const env = process.env.FITGATE_PORT;
  if (env && /^\d+$/.test(env)) return Number(env);
  return loadConfig().port;
}

export function daemonUrl(port = daemonPort()): string {
  return `http://127.0.0.1:${port}`;
}

export async function daemonFetch<T = unknown>(
  p: string,
  init: RequestInit & { timeoutMs?: number; port?: number } = {},
): Promise<T> {
  const { timeoutMs = 5000, port, ...rest } = init;
  const res = await fetch(daemonUrl(port ?? daemonPort()) + p, {
    ...rest,
    headers: { "Content-Type": "application/json", ...(rest.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`daemon ${p} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function isDaemonUp(port = daemonPort(), timeoutMs = 1000): Promise<boolean> {
  try {
    const r = await daemonFetch<{ ok?: boolean }>("/health", { port, timeoutMs });
    return Boolean(r && r.ok);
  } catch {
    return false;
  }
}

/** Absolute path to the CLI entry (dist/index.js) for spawning a daemon. */
export function cliEntryPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const name of ["index.js", "index.ts"]) {
    const candidate = path.join(here, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(here, "index.js");
}

/** Spawn `fitgate daemon` detached (stdio ignored, unref'd). */
export function spawnDaemonDetached(port = daemonPort()): void {
  // Inside a standalone SEA executable there is no on-disk entry file to
  // re-invoke: process.execPath *is* the whole CLI, so re-run it directly
  // with just the subcommand (Node gives it argv = [exe, exe, ...args]).
  let args: string[];
  if (isSea()) {
    args = ["daemon"];
  } else {
    const entry = cliEntryPath();
    args = entry.endsWith(".ts") ? ["--import", "tsx", entry, "daemon"] : [entry, "daemon"];
  }
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, FITGATE_DAEMON_CHILD: "1", FITGATE_PORT: String(port) },
  });
  child.on("error", () => {
    /* swallow */
  });
  child.unref();
}

/** Make sure a daemon answers; spawn one if needed and wait up to `waitMs` for /health. */
export async function ensureDaemon(port = daemonPort(), waitMs = 3000): Promise<boolean> {
  if (await isDaemonUp(port)) return true;
  spawnDaemonDetached(port);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    if (await isDaemonUp(port, 500)) return true;
  }
  return false;
}

// ---- typed helpers ---------------------------------------------------------

export async function getStatus(port?: number): Promise<DaemonStatus> {
  return DaemonStatus.parse(await daemonFetch("/v1/status", { port }));
}

export async function getRules(port?: number): Promise<GateRules> {
  return GateRules.parse(await daemonFetch("/v1/rules", { port }));
}

export async function openGate(req: GateOpenRequest, port?: number): Promise<GateOpenResponse> {
  return GateOpenResponse.parse(await daemonFetch("/v1/gate", { method: "POST", body: JSON.stringify(req), port, timeoutMs: 10_000 }));
}

export async function waitGate(id: string, timeoutSeconds: number, port?: number): Promise<Gate> {
  return Gate.parse(
    await daemonFetch(`/v1/gate/${encodeURIComponent(id)}/wait?timeout=${timeoutSeconds}`, {
      port,
      timeoutMs: timeoutSeconds * 1000 + 5000,
    }),
  );
}

export async function resolveGate(id: string, body: GateResolveRequest, port?: number): Promise<Gate> {
  return Gate.parse(await daemonFetch(`/v1/gate/${encodeURIComponent(id)}/resolve`, { method: "POST", body: JSON.stringify(body), port }));
}

export async function pauseDaemon(minutes: number | undefined, port?: number): Promise<DaemonStatus> {
  return DaemonStatus.parse(await daemonFetch("/v1/pause", { method: "POST", body: JSON.stringify({ minutes }), port }));
}

export async function resumeDaemon(port?: number): Promise<DaemonStatus> {
  return DaemonStatus.parse(await daemonFetch("/v1/resume", { method: "POST", body: "{}", port }));
}
