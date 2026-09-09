/**
 * `fitgate mcp` — stdio MCP server for agents without hook support.
 * Tools: fitgate_gate, fitgate_status, fitgate_done. Fails open like the hook.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureDaemon, getRules, getStatus, openGate, resolveGate, waitGate } from "./client.js";
import { cliVersion } from "./version.js";

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

export async function runMcpServer(): Promise<void> {
  const server = new McpServer({ name: "fitgate", version: cliVersion() });

  server.registerTool(
    "fitgate_gate",
    {
      title: "FitGate approval gate",
      description:
        "MUST be called BEFORE asking the human to approve any action (running a shell command, editing or writing files, " +
        "installing packages, making network requests, spending money). It opens a short micro-workout gate for the human and " +
        "blocks until they finish. Returns 'cleared' when you may proceed to ask for approval as usual, or 'blocked: ...' when you " +
        "must wait and call it again later. Pass a short tool name and a one-line summary of what you want to do; never include " +
        "file contents or secrets.",
      inputSchema: {
        tool: z.string().max(120).optional().describe("Name of the tool/action about to be run, e.g. 'shell', 'write_file'"),
        summary: z.string().max(300).optional().describe("One-line, human-readable summary of the action"),
      },
    },
    async ({ tool, summary }) => {
      try {
        if (!(await ensureDaemon())) return text("cleared");
        const res = await openGate({ agent: "mcp", tool, summary });
        if (res.status === "pass") return text("cleared");
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
        while (gate.state === "open" && Date.now() < deadline) gate = await waitGate(gate.id, 30);
        if (gate.state === "completed") return text("cleared");
        if (onSkip === "deny") return text(`blocked: the human ${gate.state === "skipped" ? "skipped" : "did not finish"} the micro-workout (${gate.task.label}). Wait, then call fitgate_gate again before asking for approval.`);
        return text("cleared");
      } catch {
        return text("cleared");
      }
    },
  );

  server.registerTool(
    "fitgate_status",
    {
      title: "FitGate status",
      description: "Today's FitGate stats (gates served, completed, skipped), streak, pause state and the currently open gate, as JSON.",
      inputSchema: {},
    },
    async () => {
      try {
        if (!(await ensureDaemon())) return text(JSON.stringify({ error: "daemon not running" }));
        return text(JSON.stringify(await getStatus(), null, 2));
      } catch (err) {
        return text(JSON.stringify({ error: (err as Error).message }));
      }
    },
  );

  server.registerTool(
    "fitgate_done",
    {
      title: "Mark FitGate micro-workout done",
      description:
        "Resolves the currently open FitGate gate as completed. Only call this when the human explicitly tells you they finished the exercise.",
      inputSchema: {},
    },
    async () => {
      try {
        const st = await getStatus();
        if (!st.openGate) return text("no open gate");
        const g = await resolveGate(st.openGate.id, { outcome: "completed" });
        return text(`done: ${g.task.label}`);
      } catch (err) {
        return text(`error: ${(err as Error).message}`);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
