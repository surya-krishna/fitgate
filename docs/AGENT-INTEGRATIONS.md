# Agent integrations

How `fitgate init` wires into each coding agent, and exactly what `fitgate gate` prints back.
All facts below were checked against the vendors' docs in September 2026; links in each section.
If a vendor changes its hook protocol, the fix lives in one adapter file: `packages/cli/src/agents/<agent>.ts`.

The universal contract for an adapter:

```ts
interface AgentAdapter {
  id: AgentId;
  detect(): Promise<boolean>;                // is the agent installed on this machine?
  install(ctx): Promise<void>;               // write hook config (idempotent, merges, never clobbers)
  uninstall(ctx): Promise<void>;
  parseStdin(json: unknown): { tool?: string; summary?: string; sessionId?: string };
  respond(outcome: "pass" | "deny", message?: string): { stdout: string; exitCode: number };
}
```

| Agent | Tier | Mechanism | Passthrough (let the agent's own prompt show) | Deny (hard mode) |
|---|---|---|---|---|
| Claude Code | 1 | `PermissionRequest` hook | exit 0, **no stdout** | `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":"deny","decisionReason":"…"}}` |
| Cursor | 1 | `beforeShellExecution` + `beforeMCPExecution` hooks | `{"permission":"ask","user_message":"…"}` | `{"permission":"deny","user_message":"…","agent_message":"…"}` |
| GitHub Copilot CLI | 1 | `preToolUse` hook | `{"permissionDecision":"ask"}` | `{"permissionDecision":"deny","permissionDecisionReason":"…"}` |
| OpenAI Codex CLI | 1 | `PermissionRequest` hook | exit 0, no stdout | `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"…"}}}` |
| Gemini CLI | 2 | `BeforeTool` hook | exit 0, `{}` | `{"decision":"deny","reason":"…"}` |
| Windsurf / Devin Desktop | 2 | `pre_run_command`, `pre_mcp_tool_use`, `pre_write_code` | exit 0 | exit 2 |
| Augment (Auggie) | 2 | `PreToolUse` hook | exit 0, no stdout | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}` |
| Kiro | 2 | `PreToolUse` hook | exit 0 | exit 1 + stderr |
| Amp | 2 | legacy `delegate` permission helper | exit 1 (= ask operator) | exit 2 |
| Cline | 3 | `PreToolUse` script (macOS/Linux) | `{"cancel":false}` | `{"cancel":true,"errorMessage":"…"}` |
| opencode, Roo Code, Aider, Zed, anything else | 3 | MCP tool `fitgate_gate` + rules file, or `fitgate wrap` | tool returns "cleared" | tool returns "blocked" |

"Tier" = how reliably the interception happens: 1 = fires exactly at the human-approval moment; 2 = fires before every matching tool call (FitGate's cooldown makes this fine in practice); 3 = depends on the model following instructions.

---

## Claude Code

Docs: <https://code.claude.com/docs/en/hooks>

`PermissionRequest` fires precisely when Claude Code is about to ask the human. Exit 0 with empty stdout = "no decision, show the normal dialog" — exactly what we want. Default hook timeout is 600 s; we set it explicitly to `waitTimeoutSeconds + 30`.

Written to `~/.claude/settings.json` (merged, keyed by a `"// fitgate"` marker so re-running `init` doesn't duplicate):

```json
{
  "hooks": {
    "PermissionRequest": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "fitgate gate --agent claude-code", "timeout": 540 } ] }
    ],
    "SessionStart": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "fitgate daemon --ensure", "timeout": 10 } ] }
    ]
  }
}
```

Stdin we care about: `tool_name`, `tool_input.command` / `tool_input.file_path` / `tool_input.description` (for the summary), `session_id`.

Notes:
* `PermissionRequest` does **not** fire in `claude -p` headless runs or with `--dangerously-skip-permissions` — nothing to gate there, which is correct.
* Windows: Claude Code runs hooks through PowerShell; `fitgate` is on PATH after global npm install, so the same command works.
* We deliberately do not use `PreToolUse` (would fire on every read/grep) or `Notification` (non-blocking).

## Cursor

Docs: <https://cursor.com/docs/agent/hooks>

`~/.cursor/hooks.json` (user-level; the command runs from `~/.cursor/`):

```json
{
  "version": 1,
  "hooks": {
    "beforeShellExecution": [ { "command": "fitgate gate --agent cursor", "timeout": 540, "failClosed": false } ],
    "beforeMCPExecution":   [ { "command": "fitgate gate --agent cursor", "timeout": 540, "failClosed": false } ]
  }
}
```

Response fields are snake_case. `"ask"` hands control to Cursor's normal approval prompt. `failClosed:false` keeps us fail-open. Stdin: `command`, `cwd` (shell) or `tool_name`, `mcp_server_name` (MCP), plus `conversation_id`.

## GitHub Copilot CLI

Docs: <https://docs.github.com/en/copilot/reference/hooks-configuration>

`~/.copilot/hooks/fitgate.json`:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      { "type": "command", "bash": "fitgate gate --agent copilot", "powershell": "fitgate gate --agent copilot", "timeoutSec": 540 }
    ]
  }
}
```

Stdin (camelCase): `sessionId`, `toolName`, `toolArgs`. Timeouts are fail-open (good); a non-zero exit is fail-**closed**, so the adapter always exits 0 and expresses deny via JSON. `permissionRequest` also exists; we prefer `preToolUse` + `"ask"` because its semantics are documented.

## OpenAI Codex CLI

Docs: <https://developers.openai.com/codex/hooks>

`~/.codex/hooks.json`:

```json
{
  "hooks": {
    "PermissionRequest": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "fitgate gate --agent codex", "commandWindows": "fitgate gate --agent codex", "timeout": 540, "statusMessage": "FitGate: micro-workout time" } ] }
    ]
  }
}
```

Stdin mirrors Claude Code (`tool_name`, `tool_input`, `session_id`, `turn_id`). Hooks are enabled by default; users can disable with `[features] hooks = false`.

## Gemini CLI

Docs: <https://geminicli.com/docs/hooks/reference/>

`~/.gemini/settings.json` → `hooks.BeforeTool` with matcher `run_shell_command|write_file|replace`, `timeout` in **milliseconds** (`540000`). There is no "ask" decision; we return `{}` (passthrough) and Gemini's own confirmation follows. Because `BeforeTool` fires on every matching tool call, the daemon's cooldown does the rate limiting.

## Windsurf (Devin Desktop)

Docs: <https://docs.devin.ai/desktop/cascade/hooks>

`~/.codeium/windsurf/hooks.json` → `pre_run_command`, `pre_mcp_tool_use`, `pre_write_code` with `{"command": "fitgate gate --agent windsurf", "powershell": "fitgate gate --agent windsurf"}`. Exit 0 = proceed, exit 2 = block. Stdin: `agent_action_name`, `tool_info.command_line` etc.

## Augment, Kiro, Amp, Cline

See the table; each has a tiny adapter. Amp's legacy `delegate` helper is a perfect fit (exit 1 = "ask the operator"). Cline hooks are macOS/Linux only.

## Everything else: MCP + rules

`fitgate init` registers the stdio MCP server (`fitgate mcp`) with every agent that supports MCP and drops a snippet into the project's `AGENTS.md`:

> Before asking the user to approve any action (running commands, editing files, spending money), call the `fitgate_gate` tool and wait for it to return `cleared`.

This relies on the model following instructions — usually fine, but it's the reason the hook-based tiers exist.

## `fitgate wrap` (experimental)

`fitgate wrap -- aider` spawns the command in a pseudo-terminal, scans output for approval-prompt patterns (`(y/n)`, `[Y/n]`, `Do you want to proceed?`, `Allow?`), and gates before forwarding the user's keystroke. It is a last resort and off by default because prompt patterns are brittle.

## Contributing an adapter

1. Copy `packages/cli/src/agents/_template.ts`.
2. Implement `detect / install / uninstall / parseStdin / respond`.
3. Add a fixture under `packages/cli/test/fixtures/<agent>/` with a real stdin sample.
4. Add a row to the table above with a link to the vendor docs.
