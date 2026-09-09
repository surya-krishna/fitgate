/** All hook adapters, in the order `fitgate init` reports them. */
import { AgentId } from "@fitgate/shared";
import type { AgentAdapter } from "./types.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { cursorAdapter } from "./cursor.js";
import { copilotAdapter } from "./copilot.js";
import { codexAdapter } from "./codex.js";
import { geminiAdapter } from "./gemini.js";
import { windsurfAdapter } from "./windsurf.js";
import { augmentAdapter } from "./augment.js";
import { kiroAdapter } from "./kiro.js";
import { ampAdapter } from "./amp.js";
import { clineAdapter } from "./cline.js";
import { genericAdapter } from "./generic.js";

export const adapters: AgentAdapter[] = [
  claudeCodeAdapter,
  cursorAdapter,
  copilotAdapter,
  codexAdapter,
  geminiAdapter,
  windsurfAdapter,
  augmentAdapter,
  kiroAdapter,
  ampAdapter,
  clineAdapter,
];

export function getAdapter(id: string): AgentAdapter {
  const found = adapters.find((a) => a.id === id);
  if (found) return found;
  const parsed = AgentId.safeParse(id);
  return genericAdapter(parsed.success ? parsed.data : "unknown");
}

export function hasAdapter(id: string): boolean {
  return adapters.some((a) => a.id === id);
}
