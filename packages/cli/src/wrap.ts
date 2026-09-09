/**
 * `fitgate wrap -- <cmd...>` — EXPERIMENTAL wrapper for agents with no hooks.
 *
 * Spawns the command with piped stdin/stdout, mirrors its output, and watches
 * for approval-prompt patterns. When one is seen, the next line the user types
 * is held back until a FitGate gate is resolved.
 *
 * Limitations (by design — Node has no built-in PTY):
 *  • The child does not see a TTY, so full-screen/TUI agents may behave
 *    differently (no colours, different prompts, line-buffered output).
 *  • Single-keypress prompts (raw mode) are only gated per line, i.e. after Enter.
 *  • Prompt detection is a regex; unusual prompt wording is missed (fail open).
 */
import { spawn } from "node:child_process";
import { ensureDaemon, getRules, openGate, waitGate } from "./client.js";

export const PROMPT_RE = /\(y\/n\)|\[Y\/n\]|\[y\/N\]|Do you want to proceed|Allow\?|Approve\?|Proceed\?|\(yes\/no\)/i;

export async function runWrap(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    process.stderr.write("usage: fitgate wrap -- <command> [args...]\n");
    return 2;
  }
  const [cmd, ...args] = argv as [string, ...string[]];
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"], env: process.env, shell: process.platform === "win32" });
  let pendingGate = false;
  let gating = false;
  const queue: Buffer[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    if (PROMPT_RE.test(chunk.toString("utf8"))) pendingGate = true;
  });

  async function gate(): Promise<void> {
    try {
      if (!(await ensureDaemon())) return;
      const res = await openGate({ agent: "wrap", tool: cmd, summary: "approval prompt detected" });
      if (res.status === "pass") return;
      let g = res.gate;
      let waitTimeoutSeconds = 480;
      try {
        waitTimeoutSeconds = (await getRules()).waitTimeoutSeconds;
      } catch {
        /* default */
      }
      const deadline = Date.now() + (waitTimeoutSeconds + 30) * 1000;
      process.stderr.write(`\n[fitgate] ${g.task.label} — ${g.nudge}\n`);
      while (g.state === "open" && Date.now() < deadline) g = await waitGate(g.id, 30);
      process.stderr.write(`[fitgate] ${g.state}\n`);
    } catch {
      /* fail open */
    }
  }

  async function drain(): Promise<void> {
    if (gating) return;
    gating = true;
    try {
      while (queue.length) {
        const line = queue.shift()!;
        if (pendingGate) {
          pendingGate = false;
          await gate();
        }
        child.stdin.write(line);
      }
    } finally {
      gating = false;
    }
  }

  process.stdin.on("data", (chunk: Buffer) => {
    queue.push(chunk);
    void drain();
  });
  process.stdin.on("end", () => child.stdin.end());
  process.stdin.resume();

  return new Promise<number>((resolve) => {
    child.on("error", (err) => {
      process.stderr.write(`fitgate wrap: ${err.message}\n`);
      resolve(127);
    });
    child.on("exit", (code) => resolve(code ?? 0));
  });
}
