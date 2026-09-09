import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DaemonStatus, Gate, GateOpenResponse, GateRules, LocalConfig } from "@fitgate/shared";
import type { RunningDaemon } from "../src/daemon/server.js";

let dir: string;
let daemon: RunningDaemon;
let base: string;

async function json<T = unknown>(p: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(base + p, { headers: { "Content-Type": "application/json" }, ...init });
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fitgate-daemon-"));
  process.env.FITGATE_HOME = dir;
  // Short cooldown + wait so the test can exercise timeouts quickly.
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify(LocalConfig.parse({ rules: { cooldownMinutes: 1, maxGatesPerDay: 5, waitTimeoutSeconds: 30 } })),
  );
  const { startDaemon } = await import("../src/daemon/server.js");
  daemon = await startDaemon({ port: 0, quiet: true, syncIntervalMs: 0, pidFile: true, log: () => {} });
  base = daemon.url;
});

afterAll(async () => {
  await daemon.close();
  delete process.env.FITGATE_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("daemon HTTP API", () => {
  it("health, status, rules and UI", async () => {
    const h = await json<{ ok: boolean; version: string }>("/health");
    expect(h.body.ok).toBe(true);
    const st = await json("/v1/status");
    expect(() => DaemonStatus.parse(st.body)).not.toThrow();
    expect(DaemonStatus.parse(st.body).openGate).toBeNull();
    const rules = GateRules.parse((await json("/v1/rules")).body);
    expect(rules.cooldownMinutes).toBe(1);
    const html = await fetch(base + "/");
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("All clear");
    expect(fs.existsSync(path.join(dir, "daemon.pid"))).toBe(true);
  });

  it("rejects bad requests and unknown routes", async () => {
    expect((await json("/v1/gate", { method: "POST", body: "{}" })).status).toBe(400);
    expect((await json("/v1/gate", { method: "POST", body: "not json" })).status).toBe(400);
    expect((await json("/nope")).status).toBe(404);
    expect((await json("/v1/gate/xyz/resolve", { method: "POST", body: JSON.stringify({ outcome: "completed" }) })).status).toBe(404);
  });

  it("opens a gate, shares it between parallel hooks, resolves it, records the event, then passes on cooldown", async () => {
    const open = GateOpenResponse.parse(
      (await json("/v1/gate", { method: "POST", body: JSON.stringify({ agent: "claude-code", tool: "Bash", summary: "npm install" }) })).body,
    );
    expect(open.status).toBe("gate");
    if (open.status !== "gate") throw new Error("unreachable");
    const gate = open.gate;
    expect(gate.state).toBe("open");
    expect(gate.task.label).toBeTruthy();
    expect(gate.nudge.length).toBeGreaterThan(0);
    expect(new Date(gate.expiresAt).getTime() - new Date(gate.openedAt).getTime()).toBe(30_000);

    // A second hook firing while the gate is open gets the SAME gate.
    const again = GateOpenResponse.parse((await json("/v1/gate", { method: "POST", body: JSON.stringify({ agent: "cursor", tool: "shell" }) })).body);
    expect(again.status === "gate" && again.gate.id === gate.id).toBe(true);

    const status = DaemonStatus.parse((await json("/v1/status")).body);
    expect(status.openGate?.id).toBe(gate.id);
    expect(status.today.gatesServed).toBe(1);

    // Long-poll wait returns early once resolved.
    const waiter = json<Gate>(`/v1/gate/${gate.id}/wait?timeout=20`);
    await new Promise((r) => setTimeout(r, 300));
    const resolved = Gate.parse(
      (await json(`/v1/gate/${gate.id}/resolve`, { method: "POST", body: JSON.stringify({ outcome: "completed", reported: { reps: 5 } }) })).body,
    );
    expect(resolved.state).toBe("completed");
    const waited = await waiter;
    expect(waited.status).toBe(200);
    expect(Gate.parse(waited.body).state).toBe("completed");

    // Event recorded.
    const events = (await json<{ events: Array<{ outcome: string; taskId?: string; reported?: { reps?: number } }> }>("/v1/events")).body.events;
    const done = events.find((e) => e.outcome === "completed");
    expect(done).toBeDefined();
    expect(done!.taskId).toBe(gate.task.id);
    expect(done!.reported).toEqual({ reps: 5 });
    const lines = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const after = DaemonStatus.parse((await json("/v1/status")).body);
    expect(after.openGate).toBeNull();
    expect(after.today.completed).toBe(1);
    expect(after.today.streakDays).toBe(1);
    expect(after.lastGateAt).not.toBeNull();

    // Cooldown pass.
    const pass = GateOpenResponse.parse((await json("/v1/gate", { method: "POST", body: JSON.stringify({ agent: "gemini", tool: "run_shell_command" }) })).body);
    expect(pass).toEqual({ status: "pass", reason: "passed_cooldown" });
    const passEvents = (await json<{ events: Array<{ outcome: string }> }>("/v1/events")).body.events;
    expect(passEvents.some((e) => e.outcome === "passed_cooldown")).toBe(true);

    // Resolving a stale id is a 404, and the resolved gate cannot be resolved twice.
    expect((await json(`/v1/gate/${gate.id}/resolve`, { method: "POST", body: JSON.stringify({ outcome: "skipped" }) })).status).toBe(404);
  });

  it("pause / resume are reflected in status and gate decisions", async () => {
    const paused = DaemonStatus.parse((await json("/v1/pause", { method: "POST", body: JSON.stringify({ minutes: 30 }) })).body);
    expect(paused.paused).toBe(true);
    expect(paused.pausedUntil).toBeDefined();
    const r = GateOpenResponse.parse((await json("/v1/gate", { method: "POST", body: JSON.stringify({ agent: "codex" }) })).body);
    expect(r).toEqual({ status: "pass", reason: "passed_paused" });
    const resumed = DaemonStatus.parse((await json("/v1/resume", { method: "POST", body: "{}" })).body);
    expect(resumed.paused).toBe(false);
  });

  it("SSE stream announces gate open + resolve", async () => {
    // Reset cooldown by editing state through a fresh status read isn't possible; instead wait for cooldown via a config with 0 cooldown.
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(LocalConfig.parse({ rules: { cooldownMinutes: 0, waitTimeoutSeconds: 30 } })));
    await json("/v1/reload", { method: "POST", body: "{}" });

    const ac = new AbortController();
    const res = await fetch(base + "/events", { signal: ac.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readUntil = async (needle: string) => {
      const deadline = Date.now() + 5000;
      while (!buffer.includes(needle) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value);
      }
      expect(buffer).toContain(needle);
    };
    await readUntil("event: status");

    const open = GateOpenResponse.parse((await json("/v1/gate", { method: "POST", body: JSON.stringify({ agent: "windsurf" }) })).body);
    expect(open.status).toBe("gate");
    await readUntil("event: gate");
    if (open.status === "gate") {
      await json(`/v1/gate/${open.gate.id}/resolve`, { method: "POST", body: JSON.stringify({ outcome: "skipped" }) });
      await readUntil("event: resolve");
      expect(buffer).toContain('"state":"skipped"');
    }
    ac.abort();
    const st = DaemonStatus.parse((await json("/v1/status")).body);
    expect(st.today.skipped).toBe(1);
  });

  it("wait returns the still-open gate after the poll timeout, and gates expire to timeout", async () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(LocalConfig.parse({ rules: { cooldownMinutes: 0, waitTimeoutSeconds: 30 } })));
    await json("/v1/reload", { method: "POST", body: "{}" });
    const open = GateOpenResponse.parse((await json("/v1/gate", { method: "POST", body: JSON.stringify({ agent: "amp" }) })).body);
    if (open.status !== "gate") throw new Error("expected gate");
    const t0 = Date.now();
    const w = Gate.parse((await json(`/v1/gate/${open.gate.id}/wait?timeout=1`)).body);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(w.state).toBe("open");

    // Expiry: the daemon's background interval marks gates `timeout` at expiresAt.
    // Exercise the same code path on a standalone engine with a past expiresAt.
    const { Engine } = await import("../src/daemon/server.js");
    const engine = new Engine(() => {}, true);
    const opened = await engine.open({ agent: "wrap" });
    expect(opened.status).toBe("gate");
    if (opened.status === "gate") {
      const waiting = engine.wait(opened.gate.id, 5000);
      engine.openGate = { ...opened.gate, expiresAt: new Date(Date.now() - 1000).toISOString() };
      engine.expireIfDue();
      const g = await waiting;
      expect(g?.state).toBe("timeout");
      expect(engine.openGate).toBeNull();
      expect(engine.state.readEvents().some((e) => e.outcome === "timeout")).toBe(true);
    }
    await json(`/v1/gate/${open.gate.id}/resolve`, { method: "POST", body: JSON.stringify({ outcome: "skipped" }) });
  });

  it("respects the daily cap and maxPerDay", async () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(LocalConfig.parse({ rules: { cooldownMinutes: 0, maxGatesPerDay: 4 } })));
    await json("/v1/reload", { method: "POST", body: "{}" });
    // 3 served so far in this file (1 completed, 2 skipped).
    const one = GateOpenResponse.parse((await json("/v1/gate", { method: "POST", body: JSON.stringify({ agent: "kiro" }) })).body);
    expect(one.status).toBe("gate");
    if (one.status === "gate") await json(`/v1/gate/${one.gate.id}/resolve`, { method: "POST", body: JSON.stringify({ outcome: "completed" }) });
    const capped = GateOpenResponse.parse((await json("/v1/gate", { method: "POST", body: JSON.stringify({ agent: "kiro" }) })).body);
    expect(capped).toEqual({ status: "pass", reason: "passed_cap" });
  });

  it("passes with passed_no_plan when the default pool is disabled", async () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(LocalConfig.parse({ useDefaultPoolWhenNoPlan: false, rules: { cooldownMinutes: 0, maxGatesPerDay: 50 } })));
    await json("/v1/reload", { method: "POST", body: "{}" });
    const r = GateOpenResponse.parse((await json("/v1/gate", { method: "POST", body: JSON.stringify({ agent: "cline" }) })).body);
    expect(r).toEqual({ status: "pass", reason: "passed_no_plan" });
  });

  it("uses a synced plan's tasks and rules when plan.json is active", async () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(LocalConfig.parse({ useDefaultPoolWhenNoPlan: false })));
    await json("/v1/reload", { method: "POST", body: "{}" });
    const plan = {
      id: "p1",
      version: 3,
      status: "active",
      title: "Desk plan",
      goals: [],
      microTasks: [{ id: "only", kind: "walk", label: "1-minute walk", instructions: "", intensity: "light", weight: 1 }],
      rules: { cooldownMinutes: 0, maxGatesPerDay: 50, quietHours: [], waitTimeoutSeconds: 60, onSkip: "deny" },
      contraindications: [],
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
    const st = DaemonStatus.parse((await json("/v1/status")).body);
    expect(st.plan).toEqual({ id: "p1", version: 3, title: "Desk plan", status: "active" });
    expect(GateRules.parse((await json("/v1/rules")).body).onSkip).toBe("deny");
    const r = GateOpenResponse.parse((await json("/v1/gate", { method: "POST", body: JSON.stringify({ agent: "mcp" }) })).body);
    expect(r.status === "gate" && r.gate.task.id === "only").toBe(true);
    if (r.status === "gate") await json(`/v1/gate/${r.gate.id}/resolve`, { method: "POST", body: JSON.stringify({ outcome: "completed" }) });
    fs.unlinkSync(path.join(dir, "plan.json"));
  });
});
