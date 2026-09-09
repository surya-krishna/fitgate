# FitGate Architecture

FitGate has three moving parts. Only the first one is required.

```
┌──────────────────────────────── developer's machine ────────────────────────────────┐
│                                                                                     │
│  Claude Code ──hook──┐                                                              │
│  Cursor ─────hook────┤     fitgate gate            fitgate daemon (127.0.0.1:4820)  │
│  Copilot ────hook────┼──▶ (stdin JSON) ──HTTP──▶  • picks a micro-task              │
│  Codex ──────hook────┤     waits…                  • cooldown / daily cap / quiet    │
│  Gemini CLI ─hook────┤                             • OS notification + web gate UI  │
│  Windsurf ───hook────┤                             • local JSON state + event log   │
│  others ──MCP tool───┘     ◀── done/skip ──────    • syncs plan + events (optional) │
│                                                          │                          │
└──────────────────────────────────────────────────────────┼──────────────────────────┘
                                                           │ HTTPS (device token)
                                             ┌─────────────▼──────────────┐
                                             │  FitGate server (optional) │
                                             │  Next.js + Postgres        │
                                             │  • onboarding + health     │
                                             │    profile (never synced   │
                                             │    to devices)             │
                                             │  • LLM plan generation     │
                                             │    OpenRouter→Gemini→OpenAI│
                                             │  • clinician review links  │
                                             │  • dashboard, billing      │
                                             └────────────────────────────┘
```

## 1. `fitgate` CLI (packages/cli) — the interceptor

Installed with `npm i -g fitgate` (or `npx fitgate init`). Sub-commands:

| Command | What it does |
|---|---|
| `fitgate init` | Detects installed agents, writes their hook config (see [AGENT-INTEGRATIONS.md](AGENT-INTEGRATIONS.md)), registers the MCP server for agents without hooks, starts the daemon. Idempotent. `--agents claude-code,cursor` to restrict; `--uninstall` to remove. |
| `fitgate gate --agent <id>` | **The hook entry point.** Reads the agent's JSON from stdin, asks the daemon for a gate, blocks until the user resolves it, then prints the agent-specific "proceed to normal approval" response. Always fails open on internal errors. |
| `fitgate daemon` | Runs the local daemon in the foreground (`init` starts it detached; a `SessionStart` hook re-starts it if it died). |
| `fitgate mcp` | stdio MCP server exposing `fitgate_gate`, `fitgate_status`, `fitgate_done`. For agents without hook support, `AGENTS.md`/rules tell the agent to call `fitgate_gate` before asking for approval. |
| `fitgate status` | Today's stats, streak, open gate, plan version. |
| `fitgate done` / `fitgate skip` | Resolve the open gate from a terminal (for people who don't want the browser page). |
| `fitgate pause [30m]` / `fitgate resume` | Temporarily pass all gates. |
| `fitgate login <server-url>` | Pairs this device with a server using an 8-char code from the dashboard. |
| `fitgate sync` | Pull the active plan, push queued events. Also runs automatically. |
| `fitgate doctor` | Verifies hooks are installed and the daemon answers. |
| `fitgate wrap -- <cmd>` | *Experimental* PTY wrapper for agents with no hooks at all: detects `(y/n)`-style prompts in the child's output and gates them. |

### The gate protocol (agent-agnostic)

1. Hook fires → `fitgate gate --agent X` receives the agent's JSON on stdin.
2. CLI extracts `{tool, summary}` (never the full tool input — no secrets leave the process) and `POST /v1/gate`.
3. Daemon decides:
   * paused / quiet hours / cooldown active / daily cap reached / no plan & default pool disabled → `{status:"pass"}` → CLI exits immediately with the agent's passthrough response.
   * otherwise it creates a `Gate` with a micro-task chosen by weighted random from the plan's pool (respecting `maxPerDay`), a nudge line, sends an OS notification, opens/focuses the gate web page.
4. CLI long-polls `GET /v1/gate/:id/wait` (30s chunks) until `completed | skipped | timeout` or `rules.waitTimeoutSeconds`.
5. CLI prints the agent-specific response:
   * completed → passthrough (agent shows its own normal approval prompt).
   * skipped/timeout → passthrough if `rules.onSkip === "pass"`, else a *deny* with the message "FitGate: finish your micro-workout, then retry".
6. Daemon appends a `GateEvent` to `~/.fitgate/events.jsonl` and, if paired, batches them to the server.

Cooldown is the key UX decision: agents ask for approval constantly; a gate every 20+ minutes is a habit, a gate every 30 seconds is uninstalled by lunch.

### Local state (`~/.fitgate/`)

```
config.json     LocalConfig (port, serverUrl, deviceToken, rules override…)
plan.json       DevicePlan synced from server (or absent → default pool)
state.json      daemon runtime state: today's counters, lastGateAt, streak, paused
events.jsonl    GateEvent log (append-only; pushed to server when paired)
daemon.log
daemon.pid
```

No health data is ever stored on the device. The plan the device receives contains task labels and rules only.

## 2. Server (optional, not in this repo)

FitGate works fully offline with zero server — a conservative built-in task pool and local state are all `packages/cli` needs. Pairing with a FitGate server (self-hosted or FitGate Cloud) is optional and adds: LLM-personalised plans, clinician review links, dashboard, and multi-device sync. That server is a separate, also-open-source (AGPL-3.0) codebase — not part of this repo. The only thing this repo needs to know about it is the sync contract in `@fitgate/shared` (`DevicePlanResponse`, `GateEvent`) and the two CLI commands that talk to it: `fitgate login <server-url>` and `fitgate sync`.

## 3. Shared packages

* `@fitgate/shared` — zod schemas for everything above. Change here first.
* `@fitgate/llm` — provider chain + plan generator + nudges. Pure functions; tested with a mocked fetch.

## Design principles

1. **Fail open, always.** A bug in FitGate must never block someone's work. Daemon unreachable → pass. Malformed hook input → pass. Timeout → pass (unless the user opts into `onSkip: deny`).
2. **Health data stays on the server; the device only sees task labels.**
3. **The LLM proposes, rules constrain, a human clinician disposes.** See [HEALTH-SAFETY.md](HEALTH-SAFETY.md).
4. **One interception protocol, many adapters.** Adding an agent = one adapter file in `packages/cli/src/agents/`.
5. **Works with zero accounts.** Default pool + local state = fully functional offline. The server is for personalization, review and multi-device sync.
