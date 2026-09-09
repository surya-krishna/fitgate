/**
 * Pure decision logic for the daemon: which task to serve, and whether a gate
 * should be served at all. No I/O, fully unit-tested.
 */
import type { GateOutcome, GateRules, MicroTaskTemplate } from "@fitgate/shared";

/**
 * Weighted-random pick over tasks that still have budget today (`maxPerDay`).
 * Returns null when every task is exhausted or the pool is empty.
 */
export function pickTask(
  tasks: readonly MicroTaskTemplate[],
  perTaskToday: Readonly<Record<string, number>>,
  rng: () => number = Math.random,
): MicroTaskTemplate | null {
  const eligible = tasks.filter((t) => {
    const served = perTaskToday[t.id] ?? 0;
    return t.maxPerDay === undefined || served < t.maxPerDay;
  });
  if (eligible.length === 0) return null;
  const total = eligible.reduce((s, t) => s + (t.weight > 0 ? t.weight : 0), 0);
  if (total <= 0) return eligible[Math.floor(rng() * eligible.length) % eligible.length] ?? null;
  let r = rng() * total;
  for (const t of eligible) {
    r -= t.weight > 0 ? t.weight : 0;
    if (r < 0) return t;
  }
  return eligible[eligible.length - 1] ?? null;
}

function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Is `now` (local time) inside any quiet-hours window? Windows whose end is
 * before their start wrap past midnight (e.g. 22:00–07:00). A window with
 * start === end is treated as empty.
 */
export function isInQuietHours(windows: GateRules["quietHours"], now: Date): boolean {
  const cur = now.getHours() * 60 + now.getMinutes();
  for (const w of windows) {
    const start = hhmmToMinutes(w.start);
    const end = hhmmToMinutes(w.end);
    if (start === end) continue;
    if (start < end) {
      if (cur >= start && cur < end) return true;
    } else if (cur >= start || cur < end) {
      return true;
    }
  }
  return false;
}

export interface RuleInput {
  rules: GateRules;
  now: Date;
  paused: boolean;
  lastGateAt: string | null;
  gatesServedToday: number;
  /** Whether there is at least one task that could be served. */
  hasTasks: boolean;
}

/** Returns the pass reason when a gate must NOT be served, or null when it should. */
export function evaluateRules(input: RuleInput): GateOutcome | null {
  const { rules, now } = input;
  if (input.paused) return "passed_paused";
  if (isInQuietHours(rules.quietHours, now)) return "passed_quiet";
  if (input.lastGateAt) {
    const elapsedMs = now.getTime() - new Date(input.lastGateAt).getTime();
    if (elapsedMs >= 0 && elapsedMs < rules.cooldownMinutes * 60_000) return "passed_cooldown";
  }
  if (input.gatesServedToday >= rules.maxGatesPerDay) return "passed_cap";
  if (!input.hasTasks) return "passed_no_plan";
  return null;
}
