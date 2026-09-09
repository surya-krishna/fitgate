/**
 * The FitGate daemon: a tiny node:http server on 127.0.0.1 that owns the gate
 * lifecycle, local state, the web UI and (optionally) server sync.
 */
import http from "node:http";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import {
  DaemonStatus,
  GateOpenRequest,
  GateResolveRequest,
  NudgeResponse,
  type Gate,
  type GateEvent,
  type GateOpenResponse,
  type GateOutcome,
  type GateRules,
  type LocalConfig,
} from "@fitgate/shared";
import { fallbackNudge } from "@fitgate/llm";
import { loadConfig, isPaired } from "../config.js";
import { effectivePlan, loadPlan } from "../plan.js";
import { StateStore } from "../state.js";
import { ensureHome, files } from "../paths.js";
import { evaluateRules, pickTask } from "./pick.js";
import { gateHtml } from "./ui.js";
import { notify } from "../notify.js";
import { openUrl } from "../open.js";
import { syncOnce, type SyncResult } from "../sync.js";
import { cliVersion } from "../version.js";
import { removeIfExists, writeFileAtomic } from "../fsutil.js";

export interface DaemonOptions {
  /** Override config.port (0 = random, handy for tests). */
  port?: number;
  /** Where log lines go (default: daemon.log + stderr when foreground). */
  log?: (line: string) => void;
  /** Write daemon.pid / clean it up on close (default true). */
  pidFile?: boolean;
  /** Sync loop interval (default 60s; 0 disables). */
  syncIntervalMs?: number;
  /** Disable notification/browser side effects (tests). */
  quiet?: boolean;
}

export interface RunningDaemon {
  port: number;
  url: string;
  close(): Promise<void>;
}

type Waiter = (gate: Gate) => void;

const MAX_BODY = 64 * 1024;

function nowIso(): string {
  return new Date().toISOString();
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

/** Gate lifecycle + state; exported for tests. */
export class Engine {
  config: LocalConfig;
  readonly state: StateStore;
  openGate: Gate | null = null;
  waiters: Waiter[] = [];
  sse = new Set<http.ServerResponse>();
  lastSync: SyncResult | null = null;
  serverConnected = false;
  port = 0;

  constructor(
    readonly log: (line: string) => void,
    readonly quiet: boolean,
  ) {
    this.config = loadConfig();
    this.state = new StateStore();
  }

  reloadConfig(): void {
    this.config = loadConfig();
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  effective() {
    return effectivePlan(this.config, loadPlan());
  }

  rules(): GateRules {
    return this.effective().rules;
  }

  status(): DaemonStatus {
    const st = this.state.get();
    const eff = this.effective();
    return DaemonStatus.parse({
      version: cliVersion(),
      paused: this.state.isPaused(),
      pausedUntil: st.pausedUntil ?? undefined,
      plan: eff.plan ? { id: eff.plan.id, version: eff.plan.version, title: eff.plan.title, status: eff.plan.status } : null,
      today: {
        gatesServed: st.gatesServed,
        completed: st.completed,
        skipped: st.skipped,
        streakDays: this.state.currentStreak(),
      },
      openGate: this.openGate,
      lastGateAt: st.lastGateAt,
      serverConnected: this.serverConnected,
    });
  }

  broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sse) {
      try {
        res.write(payload);
      } catch {
        this.sse.delete(res);
      }
    }
  }

  private event(partial: Omit<GateEvent, "id" | "deviceId" | "at">): void {
    const ev: GateEvent = {
      id: randomUUID(),
      deviceId: this.config.deviceId ?? "local",
      at: nowIso(),
      ...partial,
    };
    this.state.appendEvent(ev);
  }

  async open(req: GateOpenRequest): Promise<GateOpenResponse> {
    if (this.openGate && this.openGate.state === "open") {
      return { status: "gate", gate: this.openGate };
    }
    const eff = this.effective();
    const now = new Date();
    const st = this.state.get();
    const paused = this.state.isPaused() || eff.planPaused;
    const candidate = pickTask(eff.tasks, st.perTask);
    const reason = evaluateRules({
      rules: eff.rules,
      now,
      paused,
      lastGateAt: st.lastGateAt,
      gatesServedToday: st.gatesServed,
      hasTasks: candidate !== null,
    });
    if (reason) {
      this.event({ agent: req.agent, tool: req.tool, outcome: reason });
      return { status: "pass", reason };
    }
    const task = candidate!;
    const nudge = await this.nudge(task, req.agent);
    const gate: Gate = {
      id: randomUUID(),
      agent: req.agent,
      tool: req.tool,
      summary: req.summary,
      task,
      nudge,
      state: "open",
      openedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + eff.rules.waitTimeoutSeconds * 1000).toISOString(),
    };
    this.openGate = gate;
    this.state.recordGateServed(task.id, now);
    this.log(`gate ${gate.id} opened for ${req.agent}${req.tool ? ` (${req.tool})` : ""}: ${task.label}`);
    this.broadcast("gate", gate);
    this.broadcast("status", this.status());
    if (!this.quiet) {
      if (this.config.notify) notify("FitGate: " + task.label, nudge, this.url);
      if (this.config.openBrowser) openUrl(this.url);
    }
    return { status: "gate", gate };
  }

  private async nudge(task: Gate["task"], agent: Gate["agent"]): Promise<string> {
    if (isPaired(this.config) && this.config.serverUrl) {
      try {
        const res = await fetch(this.config.serverUrl.replace(/\/+$/, "") + "/api/v1/device/nudge", {
          method: "POST",
          headers: { Authorization: `Bearer ${this.config.deviceToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ task, agent, todayCompleted: this.state.get().completed, streakDays: this.state.currentStreak() }),
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const parsed = NudgeResponse.safeParse(await res.json());
          if (parsed.success && parsed.data.nudge.trim()) return parsed.data.nudge.trim();
        }
      } catch {
        /* fall through */
      }
    }
    return fallbackNudge();
  }

  resolve(id: string, outcome: "completed" | "skipped" | "timeout", reported?: GateEvent["reported"]): Gate | null {
    const gate = this.openGate;
    if (!gate || gate.id !== id) return null;
    if (gate.state !== "open") return gate;
    const resolvedAt = new Date();
    const resolved: Gate = { ...gate, state: outcome, resolvedAt: resolvedAt.toISOString() };
    this.openGate = null;
    const durationSeconds = Math.max(0, Math.round((resolvedAt.getTime() - new Date(gate.openedAt).getTime()) / 1000));
    if (outcome === "completed") this.state.recordCompleted();
    else this.state.recordSkipped();
    this.event({
      agent: gate.agent,
      tool: gate.tool,
      taskId: gate.task.id,
      taskKind: gate.task.kind,
      taskLabel: gate.task.label,
      outcome: outcome as GateOutcome,
      durationSeconds,
      reported,
    });
    this.log(`gate ${gate.id} ${outcome} after ${durationSeconds}s`);
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(resolved);
    this.broadcast("resolve", resolved);
    this.broadcast("status", this.status());
    return resolved;
  }

  /** Resolve when the gate changes state, or after timeoutMs with the current gate. */
  wait(id: string, timeoutMs: number): Promise<Gate | null> {
    const gate = this.openGate;
    if (!gate || gate.id !== id) return Promise.resolve(null);
    if (gate.state !== "open") return Promise.resolve(gate);
    return new Promise((resolve) => {
      let done = false;
      const waiter: Waiter = (g) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(g);
      };
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(this.openGate && this.openGate.id === id ? this.openGate : gate);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  expireIfDue(): void {
    const g = this.openGate;
    if (g && g.state === "open" && Date.now() >= new Date(g.expiresAt).getTime()) {
      this.resolve(g.id, "timeout");
    }
  }

  async sync(): Promise<SyncResult> {
    this.reloadConfig();
    const r = await syncOnce(this.config, this.state);
    this.lastSync = r;
    this.serverConnected = r.ok;
    if (!r.ok && isPaired(this.config)) this.log(`sync failed: ${r.error}`);
    else if (r.ok) this.log(`sync ok (plan v${r.planVersion ?? "-"}, pushed ${r.eventsPushed})`);
    return r;
  }
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<RunningDaemon> {
  const home = ensureHome();
  const logStream = fs.createWriteStream(files.daemonLog(), { flags: "a" });
  const log =
    opts.log ??
    ((line: string) => {
      const l = `${nowIso()} ${line}\n`;
      try {
        logStream.write(l);
      } catch {
        /* ignore */
      }
    });
  const engine = new Engine(log, Boolean(opts.quiet));
  const port = opts.port ?? engine.config.port;

  const server = http.createServer(async (req, res) => {
    try {
      await route(engine, req, res);
    } catch (err) {
      log(`request error: ${(err as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      else res.end();
    }
  });
  server.keepAliveTimeout = 65_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  engine.port = typeof addr === "object" && addr ? addr.port : port;

  if (opts.pidFile !== false) {
    try {
      writeFileAtomic(files.daemonPid(), String(process.pid));
    } catch {
      /* ignore */
    }
  }
  log(`daemon v${cliVersion()} listening on ${engine.url} (home ${home})`);

  const expiry = setInterval(() => engine.expireIfDue(), 1000);
  const heartbeat = setInterval(() => {
    for (const r of engine.sse) {
      try {
        r.write(": ping\n\n");
      } catch {
        engine.sse.delete(r);
      }
    }
  }, 15_000);
  const syncMs = opts.syncIntervalMs ?? 60_000;
  let syncTimer: NodeJS.Timeout | null = null;
  if (syncMs > 0) {
    const run = () => {
      engine.sync().catch((e) => log(`sync error: ${(e as Error).message}`));
    };
    if (isPaired(engine.config)) setTimeout(run, 500);
    syncTimer = setInterval(run, syncMs);
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(expiry);
    clearInterval(heartbeat);
    if (syncTimer) clearInterval(syncTimer);
    for (const r of engine.sse) {
      try {
        r.end();
      } catch {
        /* ignore */
      }
    }
    engine.sse.clear();
    const waiters = engine.waiters;
    engine.waiters = [];
    if (engine.openGate) for (const w of waiters) w(engine.openGate);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    if (opts.pidFile !== false) removeIfExists(files.daemonPid());
    log("daemon stopped");
    logStream.end();
  };

  return { port: engine.port, url: engine.url, close };
}

async function route(engine: Engine, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const p = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && p === "/health") return sendJson(res, 200, { ok: true, version: cliVersion() });

  if (method === "GET" && p === "/") {
    const html = gateHtml();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return void res.end(html);
  }

  if (method === "GET" && p === "/v1/status") return sendJson(res, 200, engine.status());
  if (method === "GET" && p === "/v1/rules") return sendJson(res, 200, engine.rules());

  if (method === "POST" && p === "/v1/gate") {
    const parsed = GateOpenRequest.safeParse(safeJson(await readBody(req)));
    if (!parsed.success) return sendJson(res, 400, { error: "invalid GateOpenRequest" });
    return sendJson(res, 200, await engine.open(parsed.data));
  }

  const wait = p.match(/^\/v1\/gate\/([^/]+)\/wait$/);
  if (method === "GET" && wait) {
    const id = decodeURIComponent(wait[1]!);
    const timeout = Math.min(Math.max(Number(url.searchParams.get("timeout") ?? "30"), 0), 120);
    const gate = await engine.wait(id, timeout * 1000);
    if (!gate) return sendJson(res, 404, { error: "no such gate" });
    return sendJson(res, 200, gate);
  }

  const resolveM = p.match(/^\/v1\/gate\/([^/]+)\/resolve$/);
  if (method === "POST" && resolveM) {
    const id = decodeURIComponent(resolveM[1]!);
    const parsed = GateResolveRequest.safeParse(safeJson(await readBody(req)));
    if (!parsed.success) return sendJson(res, 400, { error: "invalid GateResolveRequest" });
    const gate = engine.resolve(id, parsed.data.outcome, parsed.data.reported);
    if (!gate) return sendJson(res, 404, { error: "no such gate" });
    return sendJson(res, 200, gate);
  }

  if (method === "POST" && p === "/v1/pause") {
    const body = safeJson(await readBody(req)) as { minutes?: unknown } | null;
    const minutes = body && typeof body.minutes === "number" && body.minutes > 0 ? body.minutes : undefined;
    engine.state.pause(minutes);
    engine.broadcast("status", engine.status());
    return sendJson(res, 200, engine.status());
  }
  if (method === "POST" && p === "/v1/resume") {
    engine.state.resume();
    engine.broadcast("status", engine.status());
    return sendJson(res, 200, engine.status());
  }
  if (method === "POST" && p === "/v1/sync") {
    return sendJson(res, 200, await engine.sync());
  }
  if (method === "POST" && p === "/v1/reload") {
    engine.reloadConfig();
    return sendJson(res, 200, { ok: true });
  }

  if (method === "GET" && p === "/v1/events") {
    const since = url.searchParams.get("since") ?? undefined;
    return sendJson(res, 200, { events: engine.state.readEvents(since) });
  }

  if (method === "GET" && p === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    res.write(`event: status\ndata: ${JSON.stringify(engine.status())}\n\n`);
    if (engine.openGate) res.write(`event: gate\ndata: ${JSON.stringify(engine.openGate)}\n\n`);
    engine.sse.add(res);
    req.on("close", () => engine.sse.delete(res));
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

function safeJson(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
