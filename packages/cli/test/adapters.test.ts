import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adapters, getAdapter } from "../src/agents/registry.js";
import type { InstallContext } from "../src/agents/types.js";
import { DENY_MESSAGE } from "../src/agents/types.js";
import { registerMcp, unregisterMcp, isMcpRegistered, MCP_AGENTS } from "../src/agents/mcp-registration.js";

const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(fixturesDir, `${name}.json`), "utf8"));

describe("parseStdin", () => {
  it("claude-code", () => {
    expect(getAdapter("claude-code").parseStdin(fixture("claude-code"))).toEqual({
      tool: "Bash",
      summary: "Install vitest as a dev dependency",
      sessionId: "3f2c9d1e-7b4a-4c1e-9a1f-1b2c3d4e5f60",
    });
  });
  it("cursor shell", () => {
    expect(getAdapter("cursor").parseStdin(fixture("cursor"))).toEqual({
      tool: "shell",
      summary: "rm -rf node_modules && pnpm install",
      sessionId: "c1b2a3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    });
  });
  it("cursor mcp", () => {
    expect(getAdapter("cursor").parseStdin(fixture("cursor-mcp"))).toEqual({
      tool: "mcp__github__create_pull_request",
      summary: "github: create_pull_request",
      sessionId: "c1b2a3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    });
  });
  it("copilot", () => {
    expect(getAdapter("copilot").parseStdin(fixture("copilot"))).toEqual({
      tool: "shell",
      summary: "Push to main",
      sessionId: "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f",
    });
  });
  it("codex", () => {
    expect(getAdapter("codex").parseStdin(fixture("codex"))).toEqual({
      tool: "shell",
      summary: "Run the test suite",
      sessionId: "0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9",
    });
  });
  it("gemini", () => {
    expect(getAdapter("gemini").parseStdin(fixture("gemini"))).toEqual({
      tool: "run_shell_command",
      summary: "Build the project",
      sessionId: "gemini-1a2b3c4d",
    });
  });
  it("windsurf", () => {
    expect(getAdapter("windsurf").parseStdin(fixture("windsurf"))).toEqual({
      tool: "pre_run_command",
      summary: "docker compose up -d",
      sessionId: "traj_0123456789abcdef",
    });
  });
  it("augment", () => {
    expect(getAdapter("augment").parseStdin(fixture("augment"))).toEqual({
      tool: "save-file",
      summary: "src/index.ts",
      sessionId: "aug-7f8e9d0c",
    });
  });
  it("kiro", () => {
    expect(getAdapter("kiro").parseStdin(fixture("kiro"))).toEqual({
      tool: "execute_bash",
      summary: "terraform apply -auto-approve",
      sessionId: undefined,
    });
  });
  it("amp", () => {
    expect(getAdapter("amp").parseStdin(fixture("amp"))).toEqual({
      tool: "Bash",
      summary: "git rebase -i HEAD~3",
      sessionId: undefined,
    });
  });
  it("cline", () => {
    expect(getAdapter("cline").parseStdin(fixture("cline"))).toEqual({
      tool: "execute_command",
      summary: "npm test",
      sessionId: "1757090000000",
    });
  });
  it("never throws on garbage", () => {
    for (const a of adapters) {
      expect(() => a.parseStdin(null)).not.toThrow();
      expect(() => a.parseStdin("str")).not.toThrow();
      expect(() => a.parseStdin([1, 2])).not.toThrow();
      expect(a.parseStdin({})).toEqual({});
    }
  });
  it("truncates long summaries and never leaks the full input", () => {
    const long = "x".repeat(5000);
    const p = getAdapter("claude-code").parseStdin({ tool_name: "Write", tool_input: { file_path: long, content: "SECRET" } });
    expect(p.summary!.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(p)).not.toContain("SECRET");
  });
});

describe("respond — exact outputs per AGENT-INTEGRATIONS.md", () => {
  const msg = "FitGate: finish your micro-workout, then retry";
  it("claude-code", () => {
    const a = getAdapter("claude-code");
    expect(a.respond("pass")).toEqual({ stdout: "", exitCode: 0 });
    expect(a.respond("deny", msg)).toEqual({
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: "deny", decisionReason: msg } }),
      exitCode: 0,
    });
  });
  it("cursor", () => {
    const a = getAdapter("cursor");
    const pass = a.respond("pass");
    expect(pass.exitCode).toBe(0);
    expect(JSON.parse(pass.stdout)).toMatchObject({ permission: "ask" });
    expect(typeof JSON.parse(pass.stdout).user_message).toBe("string");
    expect(a.respond("deny", msg)).toEqual({ stdout: JSON.stringify({ permission: "deny", user_message: msg, agent_message: msg }), exitCode: 0 });
  });
  it("copilot", () => {
    const a = getAdapter("copilot");
    expect(a.respond("pass")).toEqual({ stdout: JSON.stringify({ permissionDecision: "ask" }), exitCode: 0 });
    expect(a.respond("deny", msg)).toEqual({ stdout: JSON.stringify({ permissionDecision: "deny", permissionDecisionReason: msg }), exitCode: 0 });
  });
  it("codex", () => {
    const a = getAdapter("codex");
    expect(a.respond("pass")).toEqual({ stdout: "", exitCode: 0 });
    expect(a.respond("deny", msg)).toEqual({
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: msg } } }),
      exitCode: 0,
    });
  });
  it("gemini", () => {
    const a = getAdapter("gemini");
    expect(a.respond("pass")).toEqual({ stdout: "{}", exitCode: 0 });
    expect(a.respond("deny", msg)).toEqual({ stdout: JSON.stringify({ decision: "deny", reason: msg }), exitCode: 0 });
  });
  it("windsurf", () => {
    const a = getAdapter("windsurf");
    expect(a.respond("pass")).toEqual({ stdout: "", exitCode: 0 });
    expect(a.respond("deny", msg)).toEqual({ stdout: "", exitCode: 2 });
  });
  it("augment", () => {
    const a = getAdapter("augment");
    expect(a.respond("pass")).toEqual({ stdout: "", exitCode: 0 });
    expect(a.respond("deny", msg)).toEqual({
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: msg } }),
      exitCode: 0,
    });
  });
  it("kiro", () => {
    const a = getAdapter("kiro");
    expect(a.respond("pass")).toEqual({ stdout: "", exitCode: 0 });
    expect(a.respond("deny", msg)).toEqual({ stdout: "", exitCode: 1, stderr: msg });
  });
  it("amp", () => {
    const a = getAdapter("amp");
    expect(a.respond("pass")).toEqual({ stdout: "", exitCode: 1 });
    expect(a.respond("deny", msg)).toEqual({ stdout: "", exitCode: 2 });
  });
  it("cline", () => {
    const a = getAdapter("cline");
    expect(a.respond("pass")).toEqual({ stdout: JSON.stringify({ cancel: false }), exitCode: 0 });
    expect(a.respond("deny", msg)).toEqual({ stdout: JSON.stringify({ cancel: true, errorMessage: msg }), exitCode: 0 });
  });
  it("deny defaults to the standard message", () => {
    expect(getAdapter("gemini").respond("deny").stdout).toContain(DENY_MESSAGE);
  });
  it("unknown ids fall back to a fail-open generic adapter", () => {
    expect(getAdapter("nope").respond("pass")).toEqual({ stdout: "", exitCode: 0 });
    expect(getAdapter("nope").id).toBe("unknown");
    expect(getAdapter("mcp").id).toBe("mcp");
  });
});

describe("install / uninstall merge behaviour", () => {
  let home: string;
  let ctx: InstallContext;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "fitgate-home-"));
    ctx = { home, command: "fitgate", hookTimeoutSeconds: 540, log: () => {} };
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const read = (p: string) => JSON.parse(fs.readFileSync(path.join(home, p), "utf8"));

  it("claude-code merges, is idempotent and uninstalls cleanly", async () => {
    fs.mkdirSync(path.join(home, ".claude"));
    const original = {
      permissions: { allow: ["Bash(git:*)"] },
      hooks: { PermissionRequest: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }], Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
    };
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify(original));
    const a = getAdapter("claude-code");
    expect(await a.isInstalled(ctx)).toBe(false);
    await a.install(ctx);
    await a.install(ctx);
    expect(await a.isInstalled(ctx)).toBe(true);
    const s = read(".claude/settings.json");
    expect(s.permissions).toEqual(original.permissions);
    expect(s.hooks.Stop).toEqual(original.hooks.Stop);
    expect(s.hooks.PermissionRequest).toHaveLength(2);
    expect(s.hooks.PermissionRequest[0]).toEqual(original.hooks.PermissionRequest[0]);
    expect(s.hooks.PermissionRequest[1]).toEqual({
      matcher: "",
      hooks: [{ type: "command", command: "fitgate gate --agent claude-code", timeout: 540 }],
      _fitgate: true,
    });
    expect(s.hooks.SessionStart[0].hooks[0]).toEqual({ type: "command", command: "fitgate daemon --ensure", timeout: 10 });
    await a.uninstall(ctx);
    expect(read(".claude/settings.json")).toEqual(original);
    expect(await a.isInstalled(ctx)).toBe(false);
  });

  it("gemini uses milliseconds and the documented matcher", async () => {
    const a = getAdapter("gemini");
    await a.install(ctx);
    const s = read(".gemini/settings.json");
    expect(s.hooks.BeforeTool[0].matcher).toBe("run_shell_command|write_file|replace");
    expect(s.hooks.BeforeTool[0].hooks[0].timeout).toBe(540_000);
    expect(s.hooks.BeforeTool[0].hooks[0].command).toBe("fitgate gate --agent gemini");
  });

  it("cursor writes both events with failClosed:false", async () => {
    const a = getAdapter("cursor");
    await a.install(ctx);
    const s = read(".cursor/hooks.json");
    expect(s.version).toBe(1);
    for (const ev of ["beforeShellExecution", "beforeMCPExecution"]) {
      expect(s.hooks[ev]).toEqual([{ command: "fitgate gate --agent cursor", timeout: 540, failClosed: false, _fitgate: true }]);
    }
    await a.uninstall(ctx);
    expect(read(".cursor/hooks.json").hooks).toEqual({});
  });

  it("codex hook file matches the documented shape", async () => {
    const a = getAdapter("codex");
    await a.install(ctx);
    const s = read(".codex/hooks.json");
    expect(s.hooks.PermissionRequest[0].hooks[0]).toEqual({
      type: "command",
      command: "fitgate gate --agent codex",
      commandWindows: "fitgate gate --agent codex",
      timeout: 540,
      statusMessage: "FitGate: micro-workout time",
    });
  });

  it("copilot writes its own hook file", async () => {
    const a = getAdapter("copilot");
    await a.install(ctx);
    const s = read(".copilot/hooks/fitgate.json");
    expect(s.hooks.preToolUse[0]).toMatchObject({ type: "command", bash: "fitgate gate --agent copilot", powershell: "fitgate gate --agent copilot", timeoutSec: 540 });
    await a.uninstall(ctx);
    expect(fs.existsSync(path.join(home, ".copilot/hooks/fitgate.json"))).toBe(false);
  });

  it("windsurf, amp and (non-Windows) cline install + uninstall", async () => {
    for (const id of ["windsurf", "amp", "augment", "kiro", ...(process.platform === "win32" ? [] : ["cline"])]) {
      const a = getAdapter(id);
      await a.install(ctx);
      expect(await a.isInstalled(ctx), id).toBe(true);
      await a.install(ctx);
      await a.uninstall(ctx);
      expect(await a.isInstalled(ctx), id).toBe(false);
    }
    const w = getAdapter("windsurf");
    await w.install(ctx);
    const s = read(".codeium/windsurf/hooks.json");
    expect(Object.keys(s.hooks).sort()).toEqual(["pre_mcp_tool_use", "pre_run_command", "pre_write_code"]);
  });

  it("refuses to clobber a malformed settings file", async () => {
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{ not json");
    await expect(getAdapter("claude-code").install(ctx)).rejects.toThrow();
    expect(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8")).toBe("{ not json");
  });

  it("mcp registration merges JSON and appends TOML idempotently", () => {
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "o3"\n');
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
    registerMcp(home, MCP_AGENTS);
    registerMcp(home, MCP_AGENTS);
    const claude = read(".claude.json");
    expect(claude.theme).toBe("dark");
    expect(claude.mcpServers.other).toEqual({ command: "x" });
    expect(claude.mcpServers.fitgate).toEqual({ type: "stdio", command: "fitgate", args: ["mcp"] });
    expect(read(".cursor/mcp.json").mcpServers.fitgate).toEqual({ command: "fitgate", args: ["mcp"] });
    expect(read(".gemini/settings.json").mcpServers.fitgate).toEqual({ command: "fitgate", args: ["mcp"] });
    expect(read(".codeium/windsurf/mcp_config.json").mcpServers.fitgate).toEqual({ command: "fitgate", args: ["mcp"] });
    const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    expect(toml.match(/\[mcp_servers\.fitgate\]/g)).toHaveLength(1);
    expect(toml).toContain('model = "o3"');
    for (const ag of MCP_AGENTS) expect(isMcpRegistered(home, ag), ag).toBe(true);
    unregisterMcp(home, MCP_AGENTS);
    for (const ag of MCP_AGENTS) expect(isMcpRegistered(home, ag), ag).toBe(false);
    expect(read(".claude.json")).toEqual({ mcpServers: { other: { command: "x" } }, theme: "dark" });
    expect(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8").trim()).toBe('model = "o3"');
  });
});
