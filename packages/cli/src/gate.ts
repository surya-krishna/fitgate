/**
 * `fitgate gate --agent <id>` — the hook entry point.
 *
 * Reads the agent's JSON from stdin, asks the daemon for a gate, waits for the
 * user, and prints the agent-specific response. EVERYTHING is wrapped so that
 * any internal failure results in the adapter's pass response + exit 0.
 * Nothing but the adapter response is ever written to stdout.
 */
import fs from "node:fs";
import { AgentId } from "@fitgate/shared";
import { getAdapter } from "./agents/registry.js";
import type { AdapterResponse, AgentAdapter } from "./agents/types.js";
import { DENY_MESSAGE } from "./agents/types.js";
import { ensureDaemon, getRules, openGate, waitGate } from "./client.js";
import { ensureHome, files } from "./paths.js";

function logError(msg: string): void {
  try {
    ensureHome();
    fs.appendFileSync(files.gateLog(), `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* ignore */
  }
}

/** Read all of stdin; resolves with "" if nothing arrives within `timeoutMs` or stdin is a TTY. */
export function readStdin(timeoutMs = 2000): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    const chunks: Buffer[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    process.stdin.resume();
  });
}

export function parseLenient(raw: string): unknown {
  const s = raw.trim();
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    // Maybe multiple JSON objects / trailing garbage: take the first balanced object.
    const start = s.indexOf("{");
    if (start >= 0) {
      let depth = 0;
      for (let i = start; i < s.length; i++) {
        if (s[i] === "{") depth++;
        else if (s[i] === "}") {
          depth--;
          if (depth === 0) {
            try {
              return JSON.parse(s.slice(start, i + 1));
            } catch {
              break;
            }
          }
        }
      }
    }
    return {};
  }
}

function emit(resp: AdapterResponse): never {
  if (resp.stdout) process.stdout.write(resp.stdout);
  if (resp.stderr) process.stderr.write(resp.stderr + "\n");
  process.exit(resp.exitCode);
}

export async function runGate(agentIdRaw: string): Promise<never> {
  const parsedId = AgentId.safeParse(agentIdRaw);
  const adapter: AgentAdapter = getAdapter(parsedId.success ? parsedId.data : "unknown");
  try {
    const raw = await readStdin(2000);
    let parsed: ReturnType<AgentAdapter["parseStdin"]> = {};
    try {
      parsed = adapter.parseStdin(parseLenient(raw));
    } catch (err) {
      logError(`parseStdin failed for ${adapter.id}: ${(err as Error).message}`);
    }

    const up = await ensureDaemon();
    if (!up) {
      logError("daemon not reachable; failing open");
      emit(adapter.respond("pass"));
    }

    const res = await openGate({
      agent: adapter.id,
      tool: parsed.tool?.slice(0, 120),
      summary: parsed.summary?.slice(0, 300),
      sessionId: parsed.sessionId,
    });
    if (res.status === "pass") emit(adapter.respond("pass"));

    let gate = res.gate;
    let onSkip: "pass" | "deny" = "pass";
    let waitTimeoutSeconds = 480;
    try {
      const rules = await getRules();
      onSkip = rules.onSkip;
      waitTimeoutSeconds = rules.waitTimeoutSeconds;
    } catch {
      /* defaults */
    }
    const deadline = Date.now() + (waitTimeoutSeconds + 30) * 1000;
    while (gate.state === "open" && Date.now() < deadline) {
      try {
        gate = await waitGate(gate.id, 30);
      } catch (err) {
        logError(`wait failed: ${(err as Error).message}`);
        emit(adapter.respond("pass"));
      }
    }
    if (gate.state === "completed") emit(adapter.respond("pass"));
    if (onSkip === "deny") emit(adapter.respond("deny", DENY_MESSAGE));
    emit(adapter.respond("pass"));
  } catch (err) {
    logError(`gate error (${adapter.id}): ${(err as Error)?.stack ?? String(err)}`);
    emit(adapter.respond("pass"));
  }
}
