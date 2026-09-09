# fitgate

Gate your coding agent's "may I run this?" prompts behind a micro-workout.

Claude Code, Cursor, Copilot CLI, Codex, Gemini CLI, Windsurf and friends ask you for approval dozens of times a day. FitGate hooks into that exact moment: before the agent's own approval dialog appears, you do five push-ups, a 30-second plank, or a two-minute walk — then hit **Done** and carry on. A cooldown (20 minutes by default) keeps it a habit instead of a nuisance.

Everything runs on your machine. No account needed.

## Install

```bash
npm install -g fitgate     # Node ≥ 20.10
fitgate init               # or: npx fitgate init
```

`fitgate init` detects the agents you have installed, writes their hook configuration (merging into existing files — your other hooks are untouched), registers the `fitgate mcp` server where MCP is supported, and starts the local daemon. It is idempotent: run it again any time.

```
FitGate — detecting coding agents…
  ✓ Claude Code                  (tier 1)
  ✓ Cursor                       (tier 1)
  · GitHub Copilot CLI           not found
  …
Daemon running at http://127.0.0.1:4820
```

Restart your agents afterwards so they pick up the hooks. Keep <http://127.0.0.1:4820> open in a browser tab — that is where the gate appears (it also opens automatically and sends an OS notification).

## Quick start

1. `fitgate init --yes`
2. Ask your agent to do something that needs approval (`rm -rf node_modules`, say).
3. The gate page shows **"10 bodyweight squats"** with a timer. Do them. Click **Done ✓** (or run `fitgate done`).
4. The agent's normal approval prompt appears. Approve as usual.
5. `fitgate status` shows today's count and your streak.

Skipping is always allowed (**Skip** button / `fitgate skip`). By default a skip or a timeout still lets the agent proceed; set `"rules": { "onSkip": "deny" }` in `~/.fitgate/config.json` for hard mode.

## Commands

| Command | What it does |
|---|---|
| `fitgate init` | Detect agents, install hooks + MCP registration, start the daemon. `--agents claude-code,cursor` to restrict, `--uninstall` to remove, `--no-daemon`, `--yes`, `--agents-md` (append a snippet to `./AGENTS.md`). |
| `fitgate gate --agent <id>` | Hook entry point (agents call this; you normally don't). Reads the agent's JSON on stdin, blocks until the gate is resolved, prints the agent-specific response. Always fails open. |
| `fitgate daemon` | Run the daemon in the foreground. `--ensure` starts a detached one if none is running; `--stop` stops it. |
| `fitgate mcp` | stdio MCP server exposing `fitgate_gate`, `fitgate_status`, `fitgate_done`. |
| `fitgate status [--json]` | Today's stats, streak, open gate, plan version. |
| `fitgate done` / `fitgate skip` | Resolve the open gate from a terminal. |
| `fitgate pause [30m\|2h\|90]` / `fitgate resume` | Temporarily pass all gates. |
| `fitgate login <server-url>` | Pair with a FitGate server (8-character code from the dashboard). Optional. |
| `fitgate sync` | Pull the active plan, push queued events. Also runs automatically every 60 s when paired. |
| `fitgate doctor` | Verify hooks are installed and the daemon answers. |
| `fitgate wrap -- <cmd>` | *Experimental.* Wrap an agent with no hook support and gate its `(y/n)` prompts. |

## Configuration (`~/.fitgate/config.json`)

```jsonc
{
  "port": 4820,
  "useDefaultPoolWhenNoPlan": true,   // built-in bodyweight pool when no plan is synced
  "rules": {
    "cooldownMinutes": 20,            // minimum minutes between gates
    "maxGatesPerDay": 12,
    "quietHours": [{ "start": "22:00", "end": "07:00" }],
    "waitTimeoutSeconds": 480,        // how long the hook waits for you
    "onSkip": "pass"                  // or "deny" for hard mode
  },
  "openBrowser": true,
  "notify": true
}
```

Set `FITGATE_HOME` to relocate the directory (useful for tests). Other files: `plan.json` (synced plan), `state.json` (counters, streak, pause), `events.jsonl` (append-only log), `daemon.log`, `daemon.pid`, `gate.log` (hook errors).

## Per-agent notes

| Agent | Mechanism | Config file written | Notes |
|---|---|---|---|
| Claude Code | `PermissionRequest` hook (+ `SessionStart` to restart the daemon) | `~/.claude/settings.json` | Fires exactly when Claude would ask you. Not in `claude -p` or `--dangerously-skip-permissions`. |
| Cursor | `beforeShellExecution`, `beforeMCPExecution` | `~/.cursor/hooks.json` | `failClosed: false` keeps FitGate fail-open. Restart Cursor. |
| GitHub Copilot CLI | `preToolUse` | `~/.copilot/hooks/fitgate.json` | Non-zero exit would be fail-closed, so deny is expressed via JSON. |
| OpenAI Codex CLI | `PermissionRequest` | `~/.codex/hooks.json` (+ `[mcp_servers.fitgate]` in `config.toml`) | Hooks are on by default. |
| Gemini CLI | `BeforeTool` (matcher `run_shell_command\|write_file\|replace`) | `~/.gemini/settings.json` | Timeout is in milliseconds. No "ask" decision; FitGate returns `{}`. |
| Windsurf / Devin Desktop | `pre_run_command`, `pre_mcp_tool_use`, `pre_write_code` | `~/.codeium/windsurf/hooks.json` | Exit 2 = block. |
| Augment (Auggie) | `PreToolUse` | `~/.augment/settings.json` | |
| Kiro | `preToolUse` | `~/.kiro/hooks/fitgate.kiro.hook` | Best effort; check Kiro's hooks panel. |
| Amp | `delegate` permission helper | `~/.config/amp/settings.json` | Exit 1 = "ask the operator". |
| Cline | `PreToolUse` script | `~/Documents/Cline/Hooks/PreToolUse` | macOS/Linux only. Existing scripts are never overwritten. |
| Everything else | MCP tool `fitgate_gate` | `fitgate init --agents-md` adds the instruction to `AGENTS.md` | Depends on the model following instructions. |

Every entry FitGate writes carries a `"_fitgate": true` marker (or lives in a file of its own), so re-running `init` updates in place and `--uninstall` removes exactly what was added.

### `fitgate wrap` limitations

`fitgate wrap -- aider` pipes the child's stdout, looks for `(y/n)`, `[Y/n]`, `Do you want to proceed`, `Allow?` and holds the *next line you type* until a gate is resolved. Node has no built-in pseudo-terminal, so the child does not see a TTY: full-screen TUIs may render differently, single-keypress prompts are only gated after you press Enter, and unusual prompt wording is missed (which fails open). Prefer a real hook or the MCP tool whenever the agent supports one.

## Uninstall

```bash
fitgate init --uninstall      # removes hooks + MCP registrations for all agents
fitgate daemon --stop
npm uninstall -g fitgate
rm -rf ~/.fitgate             # optional: local stats + event log
```

## FAQ

**Does it read my code?**
No. The hook process receives the agent's JSON on stdin, extracts only a tool name (e.g. `Bash`) and a one-line summary (the command's description or its first 200 characters), and sends those two strings to the daemon on `127.0.0.1`. File contents, full tool inputs, and secrets never leave the hook process. If you pair with a server, the same two strings plus the outcome (`completed` / `skipped` / …) are synced as events — no health data is ever stored on the device, and no code is ever sent anywhere.

**What if the daemon is down or FitGate has a bug?**
Every path fails open: the hook prints the agent's passthrough response and exits 0. Check `~/.fitgate/gate.log` and `fitgate doctor`.

**Why isn't every approval gated?**
The cooldown. A gate every 20 minutes is a habit; a gate every 30 seconds is uninstalled by lunch. Daily cap and quiet hours apply too, and parallel hooks share one open gate.

**Can I use it without a server?**
Yes — that is the default. The built-in pool is conservative bodyweight + mobility work. A server adds an LLM-drafted, clinician-reviewed plan, multi-device sync, and a dashboard.

**Windows?**
Supported for Claude Code, Cursor, Copilot, Codex, Gemini, Windsurf, Augment, Kiro and Amp (the same `fitgate` command is on PATH after a global npm install). Cline hooks are macOS/Linux only.

## License

Copyright (c) 2026 Adroytz Technology Services LLP.

Free and open source under the **GNU Affero General Public License v3.0** — free to use, run, modify and share, commercial use included. Running a modified version as a network service triggers AGPL section 13: you must offer your users the corresponding source.

Commercial licenses without the copyleft obligation are available — <krish.surya99@gmail.com>.
