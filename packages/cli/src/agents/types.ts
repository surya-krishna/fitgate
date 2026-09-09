/**
 * The universal adapter contract (see docs/AGENT-INTEGRATIONS.md). One file per
 * agent in this directory implements it.
 */
import type { AgentId } from "@fitgate/shared";

export interface InstallContext {
  /** The user's home directory (agent configs live under it). */
  home: string;
  /** The command agents should run, normally `fitgate`. */
  command: string;
  /** Seconds a hook may block; derived from rules.waitTimeoutSeconds. */
  hookTimeoutSeconds: number;
  log: (msg: string) => void;
}

export interface ParsedStdin {
  tool?: string;
  summary?: string;
  sessionId?: string;
}

export interface AdapterResponse {
  stdout: string;
  exitCode: number;
  /** Optional stderr text (Kiro expresses deny as exit 1 + stderr). */
  stderr?: string;
}

export interface AgentAdapter {
  id: AgentId;
  displayName: string;
  /** 1 = fires exactly at the human-approval moment, 2 = before matching tool calls, 3 = model-dependent. */
  tier: 1 | 2 | 3;
  /** Is the agent installed on this machine? */
  detect(): Promise<boolean>;
  /** Write hook config (idempotent, merges, never clobbers). */
  install(ctx: InstallContext): Promise<void>;
  uninstall(ctx: InstallContext): Promise<void>;
  /** Are our hooks currently present? Used by `fitgate doctor`. */
  isInstalled(ctx: InstallContext): Promise<boolean>;
  parseStdin(json: unknown): ParsedStdin;
  respond(outcome: "pass" | "deny", message?: string): AdapterResponse;
  /** Whether this agent supports MCP servers (for `fitgate mcp` registration). */
  supportsMcp?: boolean;
  /** Human notes shown by `fitgate init`. */
  notes?: string;
}

export const DENY_MESSAGE = "FitGate: finish your micro-workout, then retry";
export const PASS_MESSAGE = "FitGate: cleared";
