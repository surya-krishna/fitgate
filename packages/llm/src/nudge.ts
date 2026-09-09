/**
 * Motivational nudges. Cheap, short, and always with an offline fallback so
 * the gate UI never waits on a network call.
 */
import type { MicroTaskTemplate, AgentId } from "@fitgate/shared";
import type { LlmClient } from "./providers.js";

export const FALLBACK_NUDGES = [
  "The agent can wait 30 seconds. Your spine can't wait 30 years.",
  "Ship the reps, then ship the code.",
  "Tiny sets compound. So does sitting.",
  "Approve yourself first.",
  "Blood flow is the best code review.",
  "You've been still for a while — this is the fix.",
  "Do it slow. Do it right. Then hit approve.",
  "Future-you is watching. Make them proud.",
  "This is the cheapest health insurance you'll ever buy.",
  "One gate at a time. That's how streaks are built.",
];

export function fallbackNudge(seed = Date.now()): string {
  return FALLBACK_NUDGES[Math.abs(seed) % FALLBACK_NUDGES.length]!;
}

export async function generateNudge(
  llm: LlmClient,
  input: { task: MicroTaskTemplate; agent: AgentId; todayCompleted: number; streakDays: number },
): Promise<string> {
  if (!llm.available) return fallbackNudge();
  try {
    const text = await llm.complete(
      [
        {
          role: "system",
          content:
            "You write ONE-line motivational nudges (max 18 words) for a programmer who must do a micro-workout before approving their AI coding agent's action. Warm, dry humour, never preachy, never mention health conditions. No emojis. No quotes.",
        },
        {
          role: "user",
          content: `task: ${input.task.label}\nagent waiting: ${input.agent}\ncompleted today: ${input.todayCompleted}\nstreak days: ${input.streakDays}`,
        },
      ],
      { temperature: 0.9, maxTokens: 60 },
    );
    const line = text.split("\n")[0]?.trim().replace(/^["']|["']$/g, "");
    return line && line.length <= 240 ? line : fallbackNudge();
  } catch {
    return fallbackNudge();
  }
}
