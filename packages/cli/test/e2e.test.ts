/**
 * End-to-end: run the built CLI (`node dist/index.js gate --agent …`) with a
 * real fixture on stdin against an in-process daemon, resolve the gate over
 * HTTP, and assert the exact hook output. Requires `pnpm build` first.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonStatus, LocalConfig } from "@fitgate/shared";
import type { RunningDaemon } from "../src/daemon/server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "dist", "index.js");
const fixture = (name: string) => fs.readFileSync(path.join(here, "fixtures", `${name}.json`), "utf8");

let dir: string;
let daemon: RunningDaemon;

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runGate(agent: string, stdin: string, env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "gate", "--agent", agent], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(stdin);
  });
}

async function resolveOpenGateAfter(ms: number, outcome: "completed" | "skipped"): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const st = DaemonStatus.parse(await (await fetch(daemon.url + "/v1/status")).json());
    if (st.openGate) {
      await fetch(`${daemon.url}/v1/gate/${st.openGate.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome }),
      });
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("no gate opened");
}

beforeAll(async () => {
  if (!fs.existsSync(cli)) throw new Error(`dist/index.js not found — run \`pnpm --filter fitgate build\` before the tests (${cli})`);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fitgate-e2e-"));
  process.env.FITGATE_HOME = dir;
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(LocalConfig.parse({ rules: { cooldownMinutes: 0, maxGatesPerDay: 50 } })));
  const { startDaemon } = await import("../src/daemon/server.js");
  daemon = await startDaemon({ port: 0, quiet: true, syncIntervalMs: 0, pidFile: false, log: () => {} });
});

afterAll(async () => {
  await daemon.close();
  delete process.env.FITGATE_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("fitgate gate end-to-end", () => {
  const env = () => ({ ...process.env, FITGATE_HOME: dir, FITGATE_PORT: String(daemon.port) });

  it("claude-code: completed gate → empty stdout, exit 0", async () => {
    const [run] = await Promise.all([runGate("claude-code", fixture("claude-code"), env()), resolveOpenGateAfter(500, "completed")]);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe("");
    expect(run.code).toBe(0);
    const st = DaemonStatus.parse(await (await fetch(daemon.url + "/v1/status")).json());
    expect(st.today.completed).toBe(1);
    expect(st.openGate).toBeNull();
    const events = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events.at(-1)).toMatchObject({ agent: "claude-code", tool: "Bash", outcome: "completed" });
  });

  it('cursor: completed gate → {"permission":"ask",...}, exit 0', async () => {
    const [run] = await Promise.all([runGate("cursor", fixture("cursor"), env()), resolveOpenGateAfter(500, "completed")]);
    expect(run.code).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out).toMatchObject({ permission: "ask" });
    expect(typeof out.user_message).toBe("string");
    const events = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events.at(-1)).toMatchObject({ agent: "cursor", tool: "shell", outcome: "completed" });
  });

  it("skipped gate with onSkip=pass still passes through", async () => {
    const [run] = await Promise.all([runGate("gemini", fixture("gemini"), env()), resolveOpenGateAfter(300, "skipped")]);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("{}");
  });

  it("skipped gate with onSkip=deny produces the deny response", async () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(LocalConfig.parse({ rules: { cooldownMinutes: 0, maxGatesPerDay: 50, onSkip: "deny" } })));
    await fetch(daemon.url + "/v1/reload", { method: "POST" });
    const [run] = await Promise.all([runGate("copilot", fixture("copilot"), env()), resolveOpenGateAfter(300, "skipped")]);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ permissionDecision: "deny", permissionDecisionReason: "FitGate: finish your micro-workout, then retry" });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(LocalConfig.parse({ rules: { cooldownMinutes: 0, maxGatesPerDay: 50 } })));
    await fetch(daemon.url + "/v1/reload", { method: "POST" });
  });

  it("garbage stdin still works (fails open on parse, still gates)", async () => {
    const [run] = await Promise.all([runGate("claude-code", "this is not json", env()), resolveOpenGateAfter(300, "completed")]);
    expect(run.stdout).toBe("");
    expect(run.code).toBe(0);
  });

  it("paused daemon → immediate pass without opening a gate", async () => {
    await fetch(daemon.url + "/v1/pause", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const t0 = Date.now();
    const run = await runGate("cursor", fixture("cursor"), env());
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(JSON.parse(run.stdout).permission).toBe("ask");
    await fetch(daemon.url + "/v1/resume", { method: "POST" });
  });

  it("daemon unreachable and unstartable → fail open, exit 0, empty stdout", async () => {
    // An out-of-range port: nothing listens there and the auto-spawned daemon cannot bind it either.
    const badHome = fs.mkdtempSync(path.join(os.tmpdir(), "fitgate-e2e-bad-"));
    const run = await runGate("claude-code", fixture("claude-code"), { ...process.env, FITGATE_HOME: badHome, FITGATE_PORT: "99999" });
    expect(run.stdout).toBe("");
    expect(run.code).toBe(0);
    expect(fs.readFileSync(path.join(badHome, "gate.log"), "utf8")).toContain("daemon not reachable");
    fs.rmSync(badHome, { recursive: true, force: true });
  });
});
